//! Gitee Open API v5 adapter. Keep provider limits and wire shapes here.
//!
//! Reference: https://gitee.com/api/v5/swagger_doc.json
//! `/files` and `/commits` are capped collections, not paginated endpoints.
//! Public responses also differ from the schema: `patch` can be an object and
//! counts/line numbers can be strings. Never infer complete evidence from a cap.

use super::*;

#[cfg(test)]
mod tests;

// Live large-PR responses stop at 200 entries and ignore page/per_page, below
// the schema's advertised 300. Treat that observed boundary as incomplete.
const FILE_LIMIT: usize = 200;
const COMMIT_LIMIT: usize = 250;
const FILE_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct GiteeProvider;

fn authenticate(request: ReviewHttpRequest, token: Option<&str>) -> ReviewHttpRequest {
    let request = request
        .header(USER_AGENT_HEADER, USER_AGENT_VALUE)
        .header(ACCEPT_HEADER, "application/json");
    // Gitee documents access_token parameters, including on PR endpoints whose
    // generated schema omits auth. Transport errors strip URLs before exposure.
    match token {
        Some(token) => request.query(&[("access_token", token)]),
        None => request,
    }
}

fn get(ctx: &ProviderContext, url: &str) -> Result<ReviewHttpRequest, ReviewPlatformError> {
    Ok(authenticate(http_client()?.get(url), ctx.token.as_deref()))
}

fn repo_url(ctx: &ProviderContext) -> String {
    format!(
        "{}/repos/{}/{}",
        ctx.api_base_url,
        urlencoding::encode(&ctx.remote.owner),
        urlencoding::encode(&ctx.remote.repository_name),
    )
}

fn pull_url(ctx: &ProviderContext, number: &str) -> Result<String, ReviewPlatformError> {
    let number = normalize_provider_item_id(number, "Pull request")?;
    Ok(format!("{}/pulls/{number}", repo_url(ctx)))
}

fn array<'a>(value: &'a Value, resource: &str) -> Result<&'a [Value], ReviewPlatformError> {
    value.as_array().map(Vec::as_slice).ok_or_else(|| {
        ReviewPlatformError::Parse(format!("Gitee {resource} response was not an array"))
    })
}

fn count(value: &Value, key: &str) -> i32 {
    value_i64(value, key).clamp(0, i64::from(i32::MAX)) as i32
}

fn count_is_known(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse::<i64>().ok())
        })
        .is_some_and(|count| count >= 0 && count <= i64::from(i32::MAX))
}

fn pull_request(value: &Value) -> Result<ReviewPlatformPullRequest, ReviewPlatformError> {
    let number = normalize_provider_item_id(&value_string(value, "number"), "Pull request")?
        .parse::<i64>()
        .map_err(|_| {
            ReviewPlatformError::Parse("Gitee pull request number overflow".to_string())
        })?;
    let state = match value_string(value, "state").as_str() {
        "merged" => ReviewItemState::Merged,
        "closed" => ReviewItemState::Closed,
        "open" if value_bool(value, "draft") => ReviewItemState::Draft,
        "open" => ReviewItemState::Open,
        other => {
            return Err(ReviewPlatformError::Parse(format!(
                "Unknown Gitee PR state: {other}"
            )))
        }
    };
    let assignees = array_items(value.get("assignees").unwrap_or(&Value::Null));
    let required = count(value, "assignees_number") as usize;
    let accepted = assignees
        .iter()
        .filter(|user| value_bool(user, "accept"))
        .count();
    // Zero required reviewers is not evidence that anyone approved. Testers and
    // can_merge_check describe different gates, not code review decisions.
    let approved = accepted > 0
        && if required > 0 {
            accepted >= required
        } else {
            accepted == assignees.len()
        };
    Ok(ReviewPlatformPullRequest {
        id: number.to_string(),
        provider_id: None,
        number,
        title: value_string(value, "title"),
        state,
        author: first_non_empty(&[
            nested_string(value, &["user", "login"]),
            nested_string(value, &["user", "name"]),
        ]),
        source_branch: nested_string(value, &["head", "ref"]),
        target_branch: nested_string(value, &["base", "ref"]),
        base_revision: nested_optional_string(value, &["base", "sha"]),
        head_revision: nested_optional_string(value, &["head", "sha"]),
        updated_at: value_string(value, "updated_at"),
        web_url: value_string(value, "html_url"),
        additions: count(value, "additions"),
        deletions: count(value, "deletions"),
        line_stats_known: Some(
            count_is_known(value, "additions") && count_is_known(value, "deletions"),
        ),
        changed_files: count(value, "changed_files"),
        changed_file_count_known: count_is_known(value, "changed_files"),
        comments: count(value, "comments"),
        review_decision: if approved {
            ReviewDecision::Approved
        } else {
            ReviewDecision::Pending
        },
        checks: empty_checks(),
    })
}

fn file(value: &Value) -> Result<ReviewPlatformFile, ReviewPlatformError> {
    let patch = value.get("patch").unwrap_or(&Value::Null);
    let path = first_non_empty(&[
        value_string(value, "filename"),
        value_string(patch, "new_path"),
    ]);
    if path.is_empty() || path.contains(['\r', '\n']) {
        return Err(ReviewPlatformError::Parse(
            "Gitee returned an invalid file path".to_string(),
        ));
    }
    let old_path = optional_string(patch, "old_path")
        .or_else(|| optional_string(value, "previous_filename"))
        .filter(|old| old != &path);
    let status = if value_bool(patch, "new_file") || value_bool(value, "new_file") {
        ReviewFileStatus::Added
    } else if value_bool(patch, "deleted_file") || value_bool(value, "deleted_file") {
        ReviewFileStatus::Deleted
    } else if value_bool(patch, "renamed_file")
        || value_bool(value, "renamed_file")
        || old_path.is_some()
    {
        ReviewFileStatus::Renamed
    } else {
        file_status(&value_string(value, "status"))
    };
    let diff = if value_bool(patch, "too_large") || value_bool(value, "too_large") {
        None
    } else {
        optional_string(patch, "diff").or_else(|| optional_string(value, "patch"))
    };
    Ok(ReviewPlatformFile {
        path,
        old_path,
        status,
        additions: count(value, "additions"),
        deletions: count(value, "deletions"),
        patch: diff,
    })
}

fn thread(value: &Value) -> ReviewPlatformThread {
    let id = value_string(value, "id");
    let inline = value_string(value, "comment_type") == "diff_comment"
        || optional_string(value, "path").is_some();
    ReviewPlatformThread {
        id: format!("gitee-comment:{id}"),
        provider_thread_id: None,
        provider_comment_id: non_empty_option(id),
        kind: if inline {
            ReviewPlatformThreadKind::Review
        } else {
            ReviewPlatformThreadKind::Comment
        },
        reply_to_provider_comment_id: non_empty_option(value_string(value, "in_reply_to_id")),
        file_path: optional_string(value, "path"),
        // position is a diff offset, not a source line. Do not display it as one.
        line: (value_i64(value, "new_line") > 0).then(|| value_i64(value, "new_line")),
        resolved: false,
        author: first_non_empty(&[
            nested_string(value, &["user", "login"]),
            nested_string(value, &["user", "name"]),
        ]),
        body: value_string(value, "body"),
        updated_at: first_non_empty(&[
            value_string(value, "updated_at"),
            value_string(value, "created_at"),
        ]),
    }
}

fn has_rel(headers: &ReviewHttpHeaders, rel: &str) -> bool {
    header_string(headers, "link").is_some_and(|link| {
        link.split(',').any(|part| {
            part.split(';').skip(1).any(|parameter| {
                let Some((name, value)) = parameter.trim().split_once('=') else {
                    return false;
                };
                name.trim() == "rel"
                    && value
                        .trim()
                        .trim_matches(['\'', '"'])
                        .split_whitespace()
                        .any(|v| v == rel)
            })
        })
    })
}

fn pagination(
    response: &JsonResponse,
    requested: PullRequestPagination,
    len: usize,
) -> ReviewPlatformPagination {
    let total = header_u64(&response.headers, "total_count")
        .or_else(|| header_u64(&response.headers, "x-total"));
    let has_next = total
        .map(|total| u64::from(requested.page) * u64::from(requested.per_page) < total)
        .unwrap_or_else(|| {
            has_rel(&response.headers, "next") || len == requested.per_page as usize
        });
    ReviewPlatformPagination {
        page: requested.page,
        per_page: requested.per_page,
        total,
        has_next,
    }
}

fn capped_pagination(
    requested: PullRequestPagination,
    len: usize,
    limit: usize,
) -> ReviewPlatformPagination {
    let mut result = pagination_from_total(requested, len);
    if len >= limit {
        result.total = None;
    }
    result
}

async fn detail(ctx: &ProviderContext, number: &str) -> Result<Value, ReviewPlatformError> {
    send_bounded_json(get(ctx, &pull_url(ctx, number)?)?).await
}

struct GiteeFileList {
    items: Vec<ReviewPlatformFile>,
    line_stats_known: bool,
}

fn file_list(values: &[Value]) -> Result<GiteeFileList, ReviewPlatformError> {
    Ok(GiteeFileList {
        items: values.iter().map(file).collect::<Result<_, _>>()?,
        line_stats_known: values
            .iter()
            .all(|value| count_is_known(value, "additions") && count_is_known(value, "deletions")),
    })
}

async fn files(ctx: &ProviderContext, number: &str) -> Result<GiteeFileList, ReviewPlatformError> {
    let response = send_review_json_response_bounded(
        get(ctx, &format!("{}/files", pull_url(ctx, number)?))?,
        FILE_RESPONSE_BYTES,
    )
    .await
    .map_err(|error| review_evidence_http_error(error, "gitee_pull_request_files_response"))?;
    file_list(array(&response.value, "files")?)
}

fn apply_file_stats(pr: &mut ReviewPlatformPullRequest, files: &GiteeFileList) {
    let additions = files
        .items
        .iter()
        .try_fold(0_i32, |n, file| n.checked_add(file.additions));
    let deletions = files
        .items
        .iter()
        .try_fold(0_i32, |n, file| n.checked_add(file.deletions));
    let complete = files.items.len() < FILE_LIMIT;
    let known = complete && files.line_stats_known && additions.is_some() && deletions.is_some();
    let preserve_known = pr.line_stats_known == Some(true)
        && (!files.line_stats_known
            || (additions.is_some_and(|count| count <= pr.additions)
                && deletions.is_some_and(|count| count <= pr.deletions)));
    if known || !preserve_known {
        pr.additions = additions.unwrap_or(i32::MAX);
        pr.deletions = deletions.unwrap_or(i32::MAX);
        pr.line_stats_known = Some(known);
    }
    let file_count = files.items.len().min(i32::MAX as usize) as i32;
    if complete || !pr.changed_file_count_known || pr.changed_files < file_count {
        pr.changed_files = file_count;
        pr.changed_file_count_known = complete;
    }
}

fn require_revisions(pr: &ReviewPlatformPullRequest) -> Result<(), ReviewPlatformError> {
    for revision in [&pr.base_revision, &pr.head_revision] {
        if !revision.as_deref().is_some_and(|sha| {
            matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
        }) {
            return Err(ReviewPlatformError::Parse(
                "Gitee PR has no immutable base/head revisions".to_string(),
            ));
        }
    }
    Ok(())
}

fn head_revision(pr: &ReviewPlatformPullRequest) -> Result<&str, ReviewPlatformError> {
    pr.head_revision
        .as_deref()
        .filter(|sha| matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| {
            ReviewPlatformError::Parse(
                "Gitee PR has no immutable head revision for CI checks".to_string(),
            )
        })
}

async fn review_parts(
    ctx: &ProviderContext,
    number: &str,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let initial = pull_request(&detail(ctx, number).await?)?;
    require_revisions(&initial)?;
    let files = files(ctx, number).await?;
    let mut confirmed = pull_request(&detail(ctx, number).await?)?;
    ensure_pull_request_revisions_stable(&initial, &confirmed)?;
    apply_file_stats(&mut confirmed, &files);
    Ok((confirmed, files.items))
}

fn review_target(
    pr: ReviewPlatformPullRequest,
    files: Vec<ReviewPlatformFile>,
) -> ReviewPlatformPullRequestReviewTarget {
    let capped = files.len() >= FILE_LIMIT;
    let mut target = review_target_from_parts(pr, files);
    if capped {
        // The provider supplies no reliable total beyond the cap. One is a
        // lower-bound sentinel, as in the existing GitCode evidence contract.
        target.omitted_file_count = target.omitted_file_count.max(1);
        target
            .limitations
            .push("provider_file_list_incomplete".to_string());
        target.limitations.push("gitee_file_list_limit".to_string());
    }
    target
}

async fn array_page(
    ctx: &ProviderContext,
    url: &str,
    requested: PullRequestPagination,
) -> Result<(Vec<Value>, ReviewPlatformPagination), ReviewPlatformError> {
    let response = send_bounded_json_response(
        get(ctx, url)?.query(&[("page", requested.page), ("per_page", requested.per_page)]),
    )
    .await?;
    let values = array(&response.value, "collection")?;
    let page = pagination(&response, requested, values.len());
    Ok((values.to_vec(), page))
}

async fn checks_page(
    ctx: &ProviderContext,
    pr: &ReviewPlatformPullRequest,
    global_pr_id: &str,
    requested: PullRequestPagination,
) -> Result<(Vec<ReviewPlatformCiItem>, ReviewPlatformPagination), ReviewPlatformError> {
    let sha = head_revision(pr)?;
    let url = format!("{}/commits/{sha}/check-runs", repo_url(ctx));
    let request = get(ctx, &url)?
        .query(&[("page", requested.page), ("per_page", requested.per_page)])
        .query(&[("filter", "latest")]);
    // This filter uses the global ID, not the repository-local PR number.
    let id = normalize_provider_item_id(global_pr_id, "Gitee pull request internal")?;
    let request = request.query(&[("pull_request_id", id)]);
    let response = send_bounded_json_response(request).await?;
    let values = array(
        response.value.get("check_runs").unwrap_or(&Value::Null),
        "check runs",
    )?;
    let mut page = pagination(&response, requested, values.len());
    if let Some(total) = response.value.get("total_count").and_then(Value::as_u64) {
        page.total = Some(total);
        page.has_next = u64::from(requested.page) * u64::from(requested.per_page) < total;
    }
    let items = values.iter().map(ci_item).collect::<Result<Vec<_>, _>>()?;
    Ok((items, page))
}

fn ci_item(value: &Value) -> Result<ReviewPlatformCiItem, ReviewPlatformError> {
    let id = normalize_provider_item_id(&value_string(value, "id"), "Check run")?;
    let output = value.get("output").unwrap_or(&Value::Null);
    let text = value_string(output, "text");
    let (log, log_truncated) = ci_log_value(text);
    Ok(ReviewPlatformCiItem {
        id: format!("gitee-check:{id}"),
        name: value_string(value, "name"),
        status: value_string(value, "status"),
        conclusion: optional_string(value, "conclusion"),
        detail: optional_string(output, "summary").or_else(|| optional_string(output, "title")),
        stage: None,
        web_url: optional_string(value, "details_url")
            .or_else(|| optional_string(value, "html_url")),
        log,
        log_truncated,
        started_at: optional_string(value, "started_at"),
        finished_at: optional_string(value, "completed_at"),
    })
}

async fn add_comment(
    ctx: &ProviderContext,
    number: &str,
    body: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, "Commenting on a Gitee pull request")?;
    if body.trim().is_empty() {
        return Err(ReviewPlatformError::Api(
            "Comment body cannot be empty".to_string(),
        ));
    }
    let value = send_json(
        authenticate(
            http_client()?.post(&format!("{}/comments", pull_url(ctx, number)?)),
            Some(token),
        )
        .json(&json!({ "body": body })),
    )
    .await?;
    normalize_provider_item_id(&value_string(&value, "id"), "Comment")?;
    Ok(ReviewPlatformActionResult {
        success: true,
        message: "Commented on Gitee pull request".to_string(),
        web_url: optional_string(&value, "html_url"),
        pull_request: None,
        thread: Some(thread(&value)),
    })
}

async fn list_page(
    ctx: &ProviderContext,
    requested: PullRequestPagination,
    state: &str,
) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
    let response = send_bounded_json_response(
        get(ctx, &format!("{}/pulls", repo_url(ctx)))?
            .query(&[("state", state), ("sort", "updated"), ("direction", "desc")])
            .query(&[("page", requested.page), ("per_page", requested.per_page)]),
    )
    .await?;
    let values = array(&response.value, "pull requests")?;
    Ok(ReviewPlatformPullRequestPage {
        items: values
            .iter()
            .map(pull_request)
            .collect::<Result<Vec<_>, _>>()?,
        pagination: pagination(&response, requested, values.len()),
    })
}

async fn list_open_or_draft(
    ctx: &ProviderContext,
    requested: PullRequestPagination,
    state: ReviewPlatformListState,
) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
    // Gitee's `state=open` contains both drafts and regular open PRs and offers
    // no draft filter. Filter that collection before paginating, never just the
    // current UI page. A lookahead match proves has_next without inventing a total.
    let end = u64::from(requested.page) * u64::from(requested.per_page);
    let mut matches = Vec::new();
    for page in 1..=MAX_REVIEW_TARGET_PAGES as u32 {
        let incoming = list_page(
            ctx,
            PullRequestPagination {
                page,
                per_page: 100,
            },
            "open",
        )
        .await?;
        if incoming.items.is_empty() && incoming.pagination.has_next {
            return Err(ReviewPlatformError::Parse(
                "Gitee returned an empty open PR page with more results pending".into(),
            ));
        }
        matches.extend(incoming.items.into_iter().filter(|pr| match state {
            ReviewPlatformListState::Draft => pr.state == ReviewItemState::Draft,
            _ => pr.state == ReviewItemState::Open,
        }));
        let complete = !incoming.pagination.has_next;
        if complete || matches.len() as u64 > end {
            let total = complete.then_some(matches.len() as u64);
            let has_next = matches.len() as u64 > end;
            return Ok(ReviewPlatformPullRequestPage {
                items: slice_page(matches, requested),
                pagination: ReviewPlatformPagination {
                    page: requested.page,
                    per_page: requested.per_page,
                    total,
                    has_next,
                },
            });
        }
    }
    Err(ReviewPlatformError::EvidenceTooLarge {
        resource: "gitee_open_pull_request_filter_pages".to_string(),
        limit: MAX_REVIEW_TARGET_PAGES,
    })
}

async fn enrich_pull_request_counts(
    ctx: &ProviderContext,
    pull_requests: Vec<ReviewPlatformPullRequest>,
) -> Vec<ReviewPlatformPullRequest> {
    let futures = pull_requests
        .into_iter()
        .map(|mut pull_request| async move {
            if let Ok(files) = files(ctx, &pull_request.id).await {
                apply_file_stats(&mut pull_request, &files);
            }
            pull_request
        });
    stream::iter(futures)
        .buffered(PROVIDER_ENRICH_CONCURRENCY)
        .collect()
        .await
}

#[async_trait::async_trait]
impl ReviewProvider for GiteeProvider {
    async fn list_pull_requests(
        &self,
        ctx: &ProviderContext,
        requested: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        self.list_pull_requests_with_state(ctx, requested, ReviewPlatformListState::All)
            .await
    }

    async fn list_pull_requests_with_state(
        &self,
        ctx: &ProviderContext,
        requested: PullRequestPagination,
        state: ReviewPlatformListState,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        let mut page = match state {
            ReviewPlatformListState::All => list_page(ctx, requested, "all").await,
            ReviewPlatformListState::Merged => list_page(ctx, requested, "merged").await,
            ReviewPlatformListState::Closed => list_page(ctx, requested, "closed").await,
            ReviewPlatformListState::Open | ReviewPlatformListState::Draft => {
                list_open_or_draft(ctx, requested, state).await
            }
        }?;
        // Enrich only the visible page, after open/draft filtering and slicing.
        // Match GitLab/GitCode: await bounded enrichment before returning rows.
        page.items = enrich_pull_request_counts(ctx, page.items).await;
        Ok(page)
    }

    async fn pull_request_detail(
        &self,
        ctx: &ProviderContext,
        number: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        let initial = detail(ctx, number).await?;
        let mut pr = pull_request(&initial)?;
        let files = files(ctx, number).await?;
        let commits_value =
            send_bounded_json(get(ctx, &format!("{}/commits", pull_url(ctx, number)?))?).await?;
        let commit_values = array(&commits_value, "commits")?;
        let commits = commit_values.iter().map(github_commit_from_value).collect();
        let mut threads = Vec::new();
        let mut ci = Vec::new();
        let mut limitations = Vec::new();
        if files.items.len() >= FILE_LIMIT {
            limitations.push("gitee_file_list_limit".to_string());
        }
        if commit_values.len() >= COMMIT_LIMIT {
            limitations.push("gitee_commit_list_limit".to_string());
        }
        for page in 1..=MAX_REVIEW_TARGET_PAGES as u32 {
            let requested = PullRequestPagination {
                page,
                per_page: 100,
            };
            let (values, pagination) = array_page(
                ctx,
                &format!("{}/comments", pull_url(ctx, number)?),
                requested,
            )
            .await?;
            threads.extend(values.iter().map(thread));
            if !pagination.has_next {
                break;
            }
            if values.is_empty() || page == MAX_REVIEW_TARGET_PAGES as u32 {
                limitations.push("provider_comment_list_incomplete".to_string());
                break;
            }
        }
        for page in 1..=MAX_REVIEW_TARGET_PAGES as u32 {
            if head_revision(&pr).is_err() {
                limitations.push("provider_ci_head_unavailable".to_string());
                break;
            }
            let (items, pagination) = checks_page(
                ctx,
                &pr,
                &value_string(&initial, "id"),
                PullRequestPagination {
                    page,
                    per_page: 100,
                },
            )
            .await?;
            let empty = items.is_empty();
            ci.extend(items);
            if !pagination.has_next {
                break;
            }
            if empty || page == MAX_REVIEW_TARGET_PAGES as u32 {
                limitations.push("provider_ci_list_incomplete".to_string());
                break;
            }
        }
        let confirmed = pull_request(&detail(ctx, number).await?)?;
        ensure_pull_request_revisions_stable(&pr, &confirmed)?;
        pr = confirmed;
        apply_file_stats(&mut pr, &files);
        pr.checks = summarize_ci_items(&ci);
        pr.comments = threads.len().min(i32::MAX as usize) as i32;
        Ok(ReviewPlatformPullRequestDetail {
            pull_request: pr,
            body: value_string(&initial, "body"),
            ci,
            files: files.items,
            commits,
            threads,
            limitations,
        })
    }

    async fn pull_request_detail_page(
        &self,
        ctx: &ProviderContext,
        number: &str,
        section: ReviewPlatformDetailSection,
        requested: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        let value = detail(ctx, number).await?;
        let mut pr = pull_request(&value)?;
        let mut result = ReviewPlatformPullRequestDetailPage {
            pull_request: pr.clone(),
            body: value_string(&value, "body"),
            ci: Vec::new(),
            files: Vec::new(),
            commits: Vec::new(),
            threads: Vec::new(),
            section,
            pagination: empty_detail_pagination(section, requested),
            limitations: Vec::new(),
        };
        match section {
            ReviewPlatformDetailSection::Overview | ReviewPlatformDetailSection::Files => {
                let files = files(ctx, number).await?;
                apply_file_stats(&mut pr, &files);
                if files.items.len() >= FILE_LIMIT {
                    result.limitations.push("gitee_file_list_limit".to_string());
                }
                if section == ReviewPlatformDetailSection::Files {
                    result.pagination = capped_pagination(requested, files.items.len(), FILE_LIMIT);
                    result.files = slice_page(files.items, requested);
                } else if head_revision(&pr).is_ok() {
                    let (checks, pagination) = checks_page(
                        ctx,
                        &pr,
                        &value_string(&value, "id"),
                        PullRequestPagination {
                            page: 1,
                            per_page: 100,
                        },
                    )
                    .await?;
                    pr.checks = summarize_ci_items(&checks);
                    if pagination.has_next {
                        result
                            .limitations
                            .push("provider_ci_list_incomplete".to_string());
                    }
                } else {
                    result
                        .limitations
                        .push("provider_ci_head_unavailable".to_string());
                }
            }
            ReviewPlatformDetailSection::Commits => {
                let value =
                    send_bounded_json(get(ctx, &format!("{}/commits", pull_url(ctx, number)?))?)
                        .await?;
                let values = array(&value, "commits")?;
                if values.len() >= COMMIT_LIMIT {
                    result
                        .limitations
                        .push("gitee_commit_list_limit".to_string());
                }
                result.pagination = capped_pagination(requested, values.len(), COMMIT_LIMIT);
                result.commits = slice_page(
                    values.iter().map(github_commit_from_value).collect(),
                    requested,
                );
            }
            ReviewPlatformDetailSection::Reviews => {
                let (values, pagination) = array_page(
                    ctx,
                    &format!("{}/comments", pull_url(ctx, number)?),
                    requested,
                )
                .await?;
                result.threads = values.iter().map(thread).collect();
                if let Some(total) = pagination.total {
                    pr.comments = total.min(i32::MAX as u64) as i32;
                }
                result.pagination = pagination;
            }
            ReviewPlatformDetailSection::Ci => {
                let (items, pagination) =
                    checks_page(ctx, &pr, &value_string(&value, "id"), requested).await?;
                pr.checks = summarize_ci_items(&items);
                if pagination.has_next || requested.page > 1 {
                    result
                        .limitations
                        .push("provider_ci_list_incomplete".to_string());
                }
                result.ci = items;
                result.pagination = pagination;
            }
        }
        let confirmed = pull_request(&detail(ctx, number).await?)?;
        ensure_pull_request_revisions_stable(&pr, &confirmed)?;
        result.pull_request = pr;
        Ok(result)
    }

    async fn pull_request_review_target(
        &self,
        ctx: &ProviderContext,
        number: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let (pr, files) = review_parts(ctx, number).await?;
        Ok(review_target(pr, files))
    }

    async fn pull_request_file_diff(
        &self,
        ctx: &ProviderContext,
        number: &str,
        base: &str,
        head: &str,
        path: &str,
        _file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        let (pr, files) = review_parts(ctx, number).await?;
        file_diff_from_parts(pr, files, base, head, path)
    }

    async fn pull_request_ci_log(
        &self,
        ctx: &ProviderContext,
        number: &str,
        ci_item_id: &str,
        _name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        let id = ci_item_id
            .strip_prefix("gitee-check:")
            .ok_or_else(|| ReviewPlatformError::Api("Invalid Gitee check run ID".to_string()))?;
        let id = normalize_provider_item_id(id, "Check run")?;
        let pr = pull_request(&detail(ctx, number).await?)?;
        head_revision(&pr)?;
        let check =
            send_bounded_json(get(ctx, &format!("{}/check-runs/{id}", repo_url(ctx)))?).await?;
        if optional_string(&check, "head_sha") != pr.head_revision {
            return Err(ReviewPlatformError::StaleTarget(
                "Gitee check run does not belong to the current PR head".to_string(),
            ));
        }
        let item = ci_item(&check)?;
        Ok(ReviewPlatformCiLog {
            ci_item_id: ci_item_id.to_string(), log: item.log, truncated: item.log_truncated,
            message: Some("Gitee exposes check output, not complete CI execution logs. Open the check details for the full run.".to_string()),
        })
    }

    async fn create_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let token = require_write_token(ctx, "Creating a Gitee pull request")?;
        let value = send_json(authenticate(http_client()?.post(&format!("{}/pulls", repo_url(ctx))), Some(token)).json(&json!({
            "title": request.title, "head": request.source_branch, "base": request.target_branch,
            "body": request.body.clone().unwrap_or_default(), "draft": request.draft.unwrap_or(false),
        }))).await?;
        let pr = pull_request(&value)?;
        Ok(ReviewPlatformActionResult {
            success: true,
            message: format!("Created Gitee pull request #{}", pr.number),
            web_url: Some(pr.web_url.clone()),
            pull_request: Some(pr),
            thread: None,
        })
    }

    async fn submit_review(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        match request.event {
            ReviewSubmitEvent::Comment => {
                add_comment(ctx, &request.pull_request_id, &request.body).await
            }
            ReviewSubmitEvent::Approve => {
                self.approve_pull_request(
                    ctx,
                    &ReviewPlatformApprovalRequest {
                        workspace_id: request.workspace_id.clone(),
                        repository_path: request.repository_path.clone(),
                        remote_id: request.remote_id.clone(),
                        pull_request_id: request.pull_request_id.clone(),
                        body: Some(request.body.clone()),
                    },
                )
                .await
            }
            ReviewSubmitEvent::RequestChanges => Err(ReviewPlatformError::UnsupportedPlatform(
                "Gitee native change requests".to_string(),
            )),
        }
    }

    async fn approve_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let token = require_write_token(ctx, "Approving a Gitee pull request")?;
        crate::review_platform_http::send_success(
            authenticate(
                http_client()?.post(&format!(
                    "{}/review",
                    pull_url(ctx, &request.pull_request_id)?
                )),
                Some(token),
            )
            .json(&json!({ "force": false })),
        )
        .await
        .map_err(review_http_error)?;
        let mut result = ReviewPlatformActionResult {
            success: true,
            message: "Approved Gitee pull request".to_string(),
            web_url: None,
            pull_request: None,
            thread: None,
        };
        if let Some(body) = request
            .body
            .as_deref()
            .filter(|body| !body.trim().is_empty())
        {
            match add_comment(ctx, &request.pull_request_id, body).await {
                Ok(comment) => {
                    result.thread = comment.thread;
                    result.web_url = comment.web_url;
                }
                Err(_) => {
                    result.success = false;
                    result.message = "Gitee approval succeeded, but the accompanying comment failed. Retry only submit_review with event=comment; do not repeat the approval.".to_string();
                }
            }
        }
        Ok(result)
    }

    async fn revoke_approval(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let token = require_write_token(ctx, "Revoking a Gitee approval")?;
        crate::review_platform_http::send_success(
            authenticate(
                http_client()?.patch(&format!(
                    "{}/assignees",
                    pull_url(ctx, &request.pull_request_id)?
                )),
                Some(token),
            )
            .json(&json!({ "reset_all": false })),
        )
        .await
        .map_err(review_http_error)?;
        Ok(ReviewPlatformActionResult {
            success: true,
            message: "Reset the current user's Gitee review approval".to_string(),
            web_url: None,
            pull_request: None,
            thread: None,
        })
    }
}

pub(super) fn normalize_issue_number(number: &str) -> Result<String, ReviewPlatformError> {
    if !number.starts_with('I')
        || number.len() < 2
        || number.len() > 32
        || !number
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err(ReviewPlatformError::Api(
            "Gitee Issue number must be an uppercase I-prefixed identifier".to_string(),
        ));
    }
    Ok(number.to_string())
}

pub(super) async fn acquire_issue_evidence(
    ctx: &ProviderContext,
    identity: &ProviderIssueIdentity,
    plan: &IssueRequestPlan,
) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
    let issue =
        send_review_json_response_bounded(get(ctx, &plan.issue_url)?, MAX_ISSUE_RESPONSE_BYTES)
            .await
            .map_err(|error| review_evidence_http_error(error, "issue_response"))?
            .value;
    ensure_provider_item_identity(identity, &issue, "number")?;
    let response = send_review_json_response_bounded(
        get(ctx, &plan.comments_url)?.query(&[
            ("page", plan.pagination.page),
            ("per_page", plan.pagination.per_page),
        ]),
        MAX_ISSUE_COMMENTS_RESPONSE_BYTES,
    )
    .await
    .map_err(|error| review_evidence_http_error(error, "issue_comments_response"));
    let mut comments_limited = false;
    let (values, has_next) = match response {
        Ok(response) => {
            let values = array(&response.value, "Issue comments")?.to_vec();
            let has_next = pagination(
                &response,
                PullRequestPagination {
                    page: plan.pagination.page,
                    per_page: plan.pagination.per_page,
                },
                values.len(),
            )
            .has_next;
            (values, has_next)
        }
        Err(ReviewPlatformError::EvidenceTooLarge { .. }) => {
            comments_limited = true;
            (Vec::new(), false)
        }
        Err(error) => return Err(error),
    };
    let comments = values
        .iter()
        .map(|comment| ReviewPlatformIssueComment {
            id: value_string(comment, "id"),
            web_url: optional_string(comment, "html_url"),
            author: nested_optional_string(comment, &["user", "login"]),
            body: value_string(comment, "body"),
            created_at: optional_string(comment, "created_at"),
            updated_at: optional_string(comment, "updated_at"),
        })
        .collect();
    let labels = array_items(issue.get("labels").unwrap_or(&Value::Null))
        .iter()
        .filter_map(|label| optional_string(label, "name"))
        .collect();
    let mut evidence = finalize_issue_mapping(
        identity,
        first_non_empty(&[
            value_string(&issue, "html_url"),
            format!(
                "https://{}/{}/issues/{}",
                identity.host, identity.project_path, identity.issue_id
            ),
        ]),
        value_string(&issue, "title"),
        bounded_issue_body(&issue, "body")?,
        value_string(&issue, "state"),
        nested_optional_string(&issue, &["user", "login"]),
        labels,
        optional_string(&issue, "created_at"),
        optional_string(&issue, "updated_at"),
        comments,
        plan.pagination,
        has_next,
        has_next.then(|| plan.pagination.page.saturating_add(1).to_string()),
    )?;
    if comments_limited {
        evidence.completeness = ReviewEvidenceCompleteness::Partial;
        evidence
            .limitations
            .push("issue_comments_response_too_large".to_string());
        evidence.fingerprint = issue_fingerprint(&evidence, plan.pagination);
    }
    Ok(evidence)
}
