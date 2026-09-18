use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const BASE: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "2222222222222222222222222222222222222222";

fn pr() -> Value {
    json!({
        "id": 10031905, "number": 69, "state": "open", "draft": false,
        "title": "Fix hooks", "body": "Review this change", "user": {"login": "author"},
        "html_url": "https://gitee.com/example/repo/pulls/69",
        "base": {"ref": "main", "sha": BASE}, "head": {"ref": "fix/hooks", "sha": HEAD},
        "assignees_number": 1, "assignees": [{"login": "reviewer", "accept": false}],
        "testers": [{"accept": true}], "can_merge_check": true,
    })
}

fn changed_file() -> Value {
    json!({
        "filename": "src/new.rs", "status": null, "additions": "1", "deletions": "1",
        "patch": {
            "diff": "@@ -1 +1 @@\n-old\n+new\n", "old_path": "src/old.rs", "new_path": "src/new.rs",
            "renamed_file": true, "new_file": false, "deleted_file": false, "too_large": false,
        },
    })
}

struct Response {
    status: u16,
    body: String,
    headers: Vec<(&'static str, String)>,
}

fn ok(value: Value) -> Response {
    Response {
        status: 200,
        body: value.to_string(),
        headers: Vec::new(),
    }
}

#[derive(Debug)]
struct Request {
    method: String,
    url: reqwest::Url,
    body: Value,
}

// Real local HTTP, including request bodies, so wire authentication, verbs and
// pagination are checked independently from the provider's mapping helpers.
fn server(responses: Vec<Response>) -> (ProviderContext, Receiver<Vec<Request>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("Missing mock request: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let (header_end, length) = loop {
                let mut buffer = [0; 2048];
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(index) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]);
                    let length = headers
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    break (index + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let mut buffer = [0; 2048];
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
            }
            let header = String::from_utf8_lossy(&bytes[..header_end]);
            let mut line = header.lines().next().unwrap().split_whitespace();
            let method = line.next().unwrap().to_string();
            let path = line.next().unwrap();
            requests.push(Request {
                method,
                url: reqwest::Url::parse(&format!("http://{address}{path}")).unwrap(),
                body: if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
                },
            });
            let headers = response
                .headers
                .into_iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect::<String>();
            write!(stream, "HTTP/1.1 {} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}", response.status, response.body.len(), headers, response.body).unwrap();
        }
        sender.send(requests).unwrap();
    });
    let remote = parse_remote(
        "origin",
        "git@gitee.com:example/repo.git",
        &ReviewPlatformAuthTokens::default(),
    )
    .unwrap();
    (
        ProviderContext {
            remote,
            api_base_url: format!("http://{address}/api/v5"),
            token: Some("test-only-token".to_string()),
        },
        receiver,
    )
}

fn requests(receiver: Receiver<Vec<Request>>) -> Vec<Request> {
    receiver.recv_timeout(Duration::from_secs(6)).unwrap()
}

#[test]
fn detects_gitee_remotes_without_gh_or_stored_credentials() {
    for url in [
        "git@gitee.com:example/repo.git",
        "https://gitee.com/example/repo.git",
        "ssh://git@gitee.com/example/repo.git",
    ] {
        let remote = parse_remote("origin", url, &ReviewPlatformAuthTokens::default()).unwrap();
        assert_eq!(remote.platform, ReviewPlatformKind::Gitee);
        assert!(remote.supported);
        assert_eq!(remote.project_path, "example/repo");
        assert!(matches!(
            remote.auth_state,
            ReviewAuthState::NotRequired | ReviewAuthState::Connected
        ));
        assert_eq!(
            provider_context(remote, &ReviewPlatformAuthTokens::default())
                .unwrap()
                .api_base_url,
            "https://gitee.com/api/v5"
        );
    }
    let unknown = parse_remote(
        "origin",
        "https://gitee.example.com/example/repo.git",
        &ReviewPlatformAuthTokens::default(),
    )
    .unwrap();
    assert!(!unknown.supported);
    assert!(provider_context_for_identity(
        ReviewPlatformKind::Gitee,
        "gitee.example.com",
        "example/repo",
        &ReviewPlatformAuthTokens::default()
    )
    .is_err());
    let ctx = provider_context_for_identity(
        ReviewPlatformKind::Gitee,
        "gitee.com",
        "example/repo",
        &ReviewPlatformAuthTokens::default(),
    )
    .unwrap();
    assert_eq!(ctx.remote.platform, ReviewPlatformKind::Gitee);
}

#[test]
fn maps_real_nested_files_and_only_claims_available_diffs() {
    let mut value = changed_file();
    let mapped = file(&value).unwrap();
    assert_eq!(mapped.status, ReviewFileStatus::Renamed);
    assert_eq!(mapped.old_path.as_deref(), Some("src/old.rs"));
    assert_eq!((mapped.additions, mapped.deletions), (1, 1));
    assert!(file_has_complete_patch(&mapped));
    value["patch"]["too_large"] = json!(true);
    assert!(!file_has_complete_patch(&file(&value).unwrap()));
    value["patch"]["new_file"] = json!(true);
    assert_eq!(file(&value).unwrap().status, ReviewFileStatus::Added);
    value["patch"]["new_file"] = json!(false);
    value["patch"]["deleted_file"] = json!(true);
    assert_eq!(file(&value).unwrap().status, ReviewFileStatus::Deleted);
    let plain = file(&json!({"filename":"a.rs","status":"modified","additions":1,"deletions":1,"patch":"@@ -1 +1 @@\n-old\n+new\n"})).unwrap();
    assert!(file_has_complete_patch(&plain));
    assert!(file(&json!({"filename":""})).is_err());
}

#[test]
fn distinguishes_review_approval_from_test_and_merge_gates() {
    let mut value = pr();
    let mapped = pull_request(&value).unwrap();
    assert_eq!(
        mapped.provider_id, None,
        "internal Gitee IDs must not replace the remote binding"
    );
    assert_eq!(mapped.id, "69");
    assert!(!mapped.changed_file_count_known);
    assert_eq!(mapped.review_decision, ReviewDecision::Pending);
    value["assignees"][0]["accept"] = json!(true);
    assert_eq!(
        pull_request(&value).unwrap().review_decision,
        ReviewDecision::Approved
    );
    value["draft"] = json!(true);
    assert_eq!(pull_request(&value).unwrap().state, ReviewItemState::Draft);
    value["state"] = json!("merged");
    assert_eq!(pull_request(&value).unwrap().state, ReviewItemState::Merged);
    value["state"] = json!("unexpected");
    assert!(pull_request(&value).is_err());
}

#[test]
fn distinguishes_unknown_line_totals_from_explicit_zero() {
    let mut value = pr();
    assert_eq!(pull_request(&value).unwrap().line_stats_known, Some(false));
    value["additions"] = json!("0");
    value["deletions"] = json!(0);
    let mapped = pull_request(&value).unwrap();
    assert_eq!(mapped.line_stats_known, Some(true));
    assert_eq!((mapped.additions, mapped.deletions), (0, 0));
    for unavailable in [Value::Null, json!("unknown"), json!(-1)] {
        value["additions"] = unavailable;
        assert_eq!(pull_request(&value).unwrap().line_stats_known, Some(false));
    }
}

#[test]
fn file_statistics_require_a_complete_collection_and_preserve_zero() {
    let mut mapped = pull_request(&pr()).unwrap();
    let files = file_list(&vec![changed_file(); 2]).unwrap();
    apply_file_stats(&mut mapped, &files);
    assert_eq!(
        (mapped.changed_files, mapped.additions, mapped.deletions),
        (2, 2, 2)
    );
    assert_eq!(mapped.line_stats_known, Some(true));
    apply_file_stats(&mut mapped, &file_list(&[]).unwrap());
    assert_eq!(
        (mapped.changed_files, mapped.additions, mapped.deletions),
        (0, 0, 0)
    );
    assert_eq!(mapped.line_stats_known, Some(true));
    apply_file_stats(
        &mut mapped,
        &file_list(&vec![changed_file(); FILE_LIMIT]).unwrap(),
    );
    assert!(!mapped.changed_file_count_known);
    assert_eq!(mapped.line_stats_known, Some(false));
}

#[test]
fn line_statistics_flag_preserves_legacy_payload_round_trips() {
    let mapped = pull_request(&pr()).unwrap();
    let mut payload = serde_json::to_value(mapped).unwrap();
    assert_eq!(payload["lineStatsKnown"], false);
    let decoded: ReviewPlatformPullRequest = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(decoded.line_stats_known, Some(false));
    payload.as_object_mut().unwrap().remove("lineStatsKnown");
    let legacy: ReviewPlatformPullRequest = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(legacy.line_stats_known, None);
    assert_eq!(serde_json::to_value(legacy).unwrap(), payload);
}

#[test]
fn source_lines_are_not_diff_positions_and_replies_keep_identity() {
    let mut comment = json!({"id":45,"comment_type":"diff_comment","path":"src/a.rs","position":"80","new_line":"12","in_reply_to_id":44});
    let mapped = thread(&comment);
    assert_eq!(mapped.line, Some(12));
    assert_eq!(mapped.reply_to_provider_comment_id.as_deref(), Some("44"));
    assert_eq!(mapped.kind, ReviewPlatformThreadKind::Review);
    comment["new_line"] = Value::Null;
    assert_eq!(thread(&comment).line, None);
}

#[test]
fn capped_collections_do_not_report_an_exact_total_or_full_coverage() {
    let files = file_list(&vec![changed_file(); FILE_LIMIT]).unwrap();
    let mut pr = pull_request(&pr()).unwrap();
    apply_file_stats(&mut pr, &files);
    assert!(!pr.changed_file_count_known);
    let target = review_target(pr, files.items);
    assert!(target.omitted_file_count > 0);
    assert!(target
        .limitations
        .contains(&"gitee_file_list_limit".to_string()));
    let first = capped_pagination(
        PullRequestPagination {
            page: 1,
            per_page: 100,
        },
        FILE_LIMIT,
        FILE_LIMIT,
    );
    assert_eq!(first.total, None);
    assert!(first.has_next);
    let last = capped_pagination(
        PullRequestPagination {
            page: 3,
            per_page: 100,
        },
        FILE_LIMIT,
        FILE_LIMIT,
    );
    assert!(!last.has_next);
    assert_eq!(last.total, None);
    assert_eq!(
        capped_pagination(
            PullRequestPagination {
                page: 1,
                per_page: 100
            },
            2,
            COMMIT_LIMIT
        )
        .total,
        Some(2)
    );
}

#[tokio::test]
async fn list_uses_gitee_headers_and_documented_auth_parameters() {
    let mut response = ok(json!([pr()]));
    response.headers.push(("total_count", "3".to_string()));
    response.headers.push((
        "Link",
        "<https://gitee.com/api/v5/x?page=2>; rel='next'".to_string(),
    ));
    let (ctx, receiver) = server(vec![response, ok(json!([changed_file()]))]);
    let page = GiteeProvider
        .list_pull_requests(
            &ctx,
            PullRequestPagination {
                page: 1,
                per_page: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.pagination.total, Some(3));
    assert!(page.pagination.has_next);
    assert_eq!(page.items[0].changed_files, 1);
    assert_eq!(page.items[0].additions, 1);
    assert_eq!(page.items[0].deletions, 1);
    assert!(page.items[0].changed_file_count_known);
    assert_eq!(page.items[0].line_stats_known, Some(true));
    let requests = requests(receiver);
    assert_stat_requests(&requests[1..], &["69"]);
    let request = &requests[0];
    assert_eq!(request.method, "GET");
    assert_eq!(request.url.path(), "/api/v5/repos/example/repo/pulls");
    let query = request.url.query_pairs().collect::<HashMap<_, _>>();
    assert_eq!(query["access_token"], "test-only-token");
    assert_eq!(query["state"], "all");
    assert_eq!(query["per_page"], "1");
    let response = JsonResponse {
        value: json!([]),
        headers: ReviewHttpHeaders::from_pairs(&[("link", "<https://gitee.com/x>; rel='next'")]),
    };
    assert!(
        pagination(
            &response,
            PullRequestPagination {
                page: 1,
                per_page: 20
            },
            0
        )
        .has_next
    );
}

fn numbered_pr(number: u32, state: &str, draft: bool) -> Value {
    let mut value = pr();
    value["number"] = json!(number);
    value["state"] = json!(state);
    value["draft"] = json!(draft);
    value
}

fn counted_page(values: Vec<Value>, total: u32) -> Response {
    let mut response = ok(json!(values));
    response.headers.push(("total_count", total.to_string()));
    response
}

fn assert_stat_requests(requests: &[Request], numbers: &[&str]) {
    let mut paths = Vec::new();
    for request in requests {
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.url.query_pairs().collect::<Vec<_>>(),
            [("access_token".into(), "test-only-token".into())]
        );
        paths.push(request.url.path().to_string());
    }
    let mut expected = numbers
        .iter()
        .map(|number| format!("/api/v5/repos/example/repo/pulls/{number}/files"))
        .collect::<Vec<_>>();
    paths.sort();
    expected.sort();
    assert_eq!(paths, expected);
}

#[tokio::test]
async fn list_returns_statistics_for_every_row_without_reordering() {
    let numbers = [9, 4, 8, 1, 7, 3, 6];
    let mut responses = vec![counted_page(
        numbers
            .iter()
            .map(|number| numbered_pr(*number, "merged", false))
            .collect(),
        27,
    )];
    responses.extend(numbers.iter().map(|_| ok(json!([changed_file()]))));
    let (ctx, receiver) = server(responses);
    let page = GiteeProvider
        .list_pull_requests_with_state(
            &ctx,
            PullRequestPagination {
                page: 2,
                per_page: 7,
            },
            ReviewPlatformListState::Merged,
        )
        .await
        .unwrap();
    assert_eq!(
        page.items.iter().map(|pr| pr.number).collect::<Vec<_>>(),
        numbers.map(i64::from)
    );
    for pr in &page.items {
        assert_eq!((pr.changed_files, pr.additions, pr.deletions), (1, 1, 1));
        assert!(pr.changed_file_count_known);
        assert_eq!(pr.line_stats_known, Some(true));
    }
    assert_eq!(page.pagination.total, Some(27));
    assert!(page.pagination.has_next);
    let requests = requests(receiver);
    assert_stat_requests(&requests[1..], &["9", "4", "8", "1", "7", "3", "6"]);
}

#[tokio::test]
async fn unavailable_list_statistics_preserve_the_original_row() {
    for known in [false, true] {
        for response in [
            Response {
                status: 403,
                body: json!({ "message": "Rate Limit Exceeded" }).to_string(),
                headers: Vec::new(),
            },
            ok(json!([{ "filename": "" }])),
        ] {
            let mut value = pr();
            if known {
                value["changed_files"] = json!(2);
                value["additions"] = json!(11);
                value["deletions"] = json!(5);
            }
            let expected = serde_json::to_value(pull_request(&value).unwrap()).unwrap();
            let (ctx, receiver) = server(vec![counted_page(vec![value], 1), response]);
            let page = GiteeProvider
                .list_pull_requests(
                    &ctx,
                    PullRequestPagination {
                        page: 1,
                        per_page: 10,
                    },
                )
                .await
                .unwrap();
            assert_eq!(page.items.len(), 1);
            assert_eq!(serde_json::to_value(&page.items[0]).unwrap(), expected);
            assert_eq!(page.pagination.total, Some(1));
            assert!(!page.pagination.has_next);
            assert_stat_requests(&requests(receiver)[1..], &["69"]);
        }
    }
}

#[tokio::test]
async fn list_does_not_certify_missing_or_invalid_file_line_counts() {
    for invalid in [
        None,
        Some(Value::Null),
        Some(json!("unknown")),
        Some(json!(-1)),
        Some(json!(2147483648_i64)),
    ] {
        let mut value = changed_file();
        if let Some(invalid) = invalid {
            value["additions"] = invalid;
        } else {
            value.as_object_mut().unwrap().remove("additions");
        }
        let (ctx, receiver) = server(vec![counted_page(vec![pr()], 1), ok(json!([value]))]);
        let page = GiteeProvider
            .list_pull_requests(
                &ctx,
                PullRequestPagination {
                    page: 1,
                    per_page: 10,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.items[0].changed_files, 1);
        assert!(page.items[0].changed_file_count_known);
        assert_eq!(page.items[0].line_stats_known, Some(false));
        assert_stat_requests(&requests(receiver)[1..], &["69"]);
    }
}

#[tokio::test]
async fn list_does_not_certify_overflowing_line_totals() {
    let mut value = changed_file();
    value["additions"] = json!(i32::MAX);
    let (ctx, receiver) = server(vec![
        counted_page(vec![pr()], 1),
        ok(json!([value.clone(), value])),
    ]);
    let page = GiteeProvider
        .list_pull_requests(
            &ctx,
            PullRequestPagination {
                page: 1,
                per_page: 10,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.items[0].changed_files, 2);
    assert!(page.items[0].changed_file_count_known);
    assert_eq!(page.items[0].line_stats_known, Some(false));
    assert_stat_requests(&requests(receiver)[1..], &["69"]);
}

#[tokio::test]
async fn unknown_line_counts_keep_files_and_available_diffs_readable() {
    let mut value = changed_file();
    value.as_object_mut().unwrap().remove("additions");
    let (ctx, receiver) = server(vec![ok(pr()), ok(json!([value])), ok(pr())]);
    let page = GiteeProvider
        .pull_request_detail_page(
            &ctx,
            "69",
            ReviewPlatformDetailSection::Files,
            PullRequestPagination {
                page: 1,
                per_page: 10,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.files.len(), 1);
    assert_eq!(page.files[0].path, "src/new.rs");
    assert!(page.files[0].patch.as_deref().unwrap().contains("+new"));
    assert_eq!(page.pull_request.changed_files, 1);
    assert!(page.pull_request.changed_file_count_known);
    assert_eq!(page.pull_request.line_stats_known, Some(false));
    assert_eq!(requests(receiver).len(), 3);
}

#[test]
fn incomplete_files_do_not_erase_complete_provider_totals() {
    let mut value = pr();
    value["changed_files"] = json!(300);
    value["additions"] = json!(1000);
    value["deletions"] = json!(500);
    let mut mapped = pull_request(&value).unwrap();
    apply_file_stats(
        &mut mapped,
        &file_list(&vec![changed_file(); FILE_LIMIT]).unwrap(),
    );
    assert_eq!(
        (mapped.changed_files, mapped.additions, mapped.deletions),
        (300, 1000, 500)
    );
    assert!(mapped.changed_file_count_known);
    assert_eq!(mapped.line_stats_known, Some(true));

    let mut unavailable = changed_file();
    unavailable["additions"] = Value::Null;
    apply_file_stats(&mut mapped, &file_list(&[unavailable]).unwrap());
    assert_eq!((mapped.additions, mapped.deletions), (1000, 500));
    assert_eq!(mapped.line_stats_known, Some(true));
}

#[tokio::test]
async fn list_statistics_distinguish_empty_changes_from_capped_collections() {
    for length in [0, FILE_LIMIT] {
        let (ctx, receiver) = server(vec![
            counted_page(vec![pr()], 1),
            ok(json!(vec![changed_file(); length])),
        ]);
        let page = GiteeProvider
            .list_pull_requests(
                &ctx,
                PullRequestPagination {
                    page: 1,
                    per_page: 10,
                },
            )
            .await
            .unwrap();
        let pr = &page.items[0];
        assert_eq!(pr.changed_files, length as i32);
        assert_eq!(pr.additions, length as i32);
        assert_eq!(pr.deletions, length as i32);
        assert_eq!(pr.changed_file_count_known, length == 0);
        assert_eq!(pr.line_stats_known, Some(length == 0));
        assert_stat_requests(&requests(receiver)[1..], &["69"]);
    }
}

#[tokio::test]
async fn repository_state_filters_keep_provider_pagination_and_totals() {
    for (state, wire, total, item_state) in [
        (
            ReviewPlatformListState::All,
            "all",
            376,
            ReviewItemState::Open,
        ),
        (
            ReviewPlatformListState::Merged,
            "merged",
            269,
            ReviewItemState::Merged,
        ),
        (
            ReviewPlatformListState::Closed,
            "closed",
            84,
            ReviewItemState::Closed,
        ),
    ] {
        let (ctx, receiver) = server(vec![
            counted_page(
                vec![numbered_pr(
                    42,
                    if wire == "all" { "open" } else { wire },
                    false,
                )],
                total,
            ),
            ok(json!([changed_file()])),
        ]);
        let page = GiteeProvider
            .list_pull_requests_with_state(
                &ctx,
                PullRequestPagination {
                    page: 2,
                    per_page: 10,
                },
                state,
            )
            .await
            .unwrap();
        assert_eq!(page.items[0].state, item_state);
        assert_eq!(page.pagination.page, 2);
        assert_eq!(page.pagination.total, Some(u64::from(total)));
        assert!(page.pagination.has_next);
        assert_eq!(page.items[0].line_stats_known, Some(true));
        let requests = requests(receiver);
        assert_stat_requests(&requests[1..], &["42"]);
        let request = &requests[0];
        let query = request.url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(query["state"], wire);
        assert_eq!(query["page"], "2");
        assert_eq!(query["per_page"], "10");
    }
}

#[tokio::test]
async fn open_and_draft_are_filtered_before_pagination_with_honest_totals() {
    for (state, draft, expected) in [
        (ReviewPlatformListState::Open, false, vec!["1", "3"]),
        (ReviewPlatformListState::Draft, true, vec!["2", "4"]),
    ] {
        let (ctx, receiver) = server(vec![
            counted_page(
                (1..=100)
                    .map(|id| numbered_pr(id, "open", id % 2 == 0))
                    .collect(),
                103,
            ),
            ok(json!([changed_file()])),
            ok(json!([changed_file()])),
        ]);
        let page = GiteeProvider
            .list_pull_requests_with_state(
                &ctx,
                PullRequestPagination {
                    page: 1,
                    per_page: 2,
                },
                state,
            )
            .await
            .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|pr| pr.id.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(page
            .items
            .iter()
            .all(|pr| (pr.state == ReviewItemState::Draft) == draft));
        assert_eq!(
            page.pagination.total, None,
            "an unscanned tail cannot supply an exact total"
        );
        assert!(page.pagination.has_next);
        assert!(page
            .items
            .iter()
            .all(|pr| pr.line_stats_known == Some(true)));
        let requests = requests(receiver);
        assert_stat_requests(&requests[1..], &expected);
        let request = &requests[0];
        let query = request.url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(query["state"], "open");
        assert_eq!(query["per_page"], "100");
    }
    let (ctx, receiver) = server(vec![
        counted_page(
            (1..=100)
                .map(|id| numbered_pr(id, "open", id % 2 == 0))
                .collect(),
            103,
        ),
        counted_page(
            vec![
                numbered_pr(101, "open", true),
                numbered_pr(102, "open", false),
                numbered_pr(103, "open", true),
            ],
            103,
        ),
        ok(json!([changed_file()])),
        ok(json!([changed_file()])),
    ]);
    let page = GiteeProvider
        .list_pull_requests_with_state(
            &ctx,
            PullRequestPagination {
                page: 26,
                per_page: 2,
            },
            ReviewPlatformListState::Draft,
        )
        .await
        .unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|pr| pr.id.as_str())
            .collect::<Vec<_>>(),
        ["101", "103"]
    );
    assert_eq!(page.pagination.total, Some(52));
    assert!(!page.pagination.has_next);
    let requests = requests(receiver);
    assert_eq!(requests.len(), 4);
    assert_stat_requests(&requests[2..], &["101", "103"]);
    assert!(requests[1]
        .url
        .query_pairs()
        .any(|(k, v)| k == "page" && v == "2"));
}

#[tokio::test]
async fn draft_filter_scans_past_pages_without_matches_and_rejects_incomplete_empty_results() {
    let (ctx, receiver) = server(vec![
        counted_page(
            (1..=100).map(|id| numbered_pr(id, "open", false)).collect(),
            101,
        ),
        counted_page(vec![numbered_pr(101, "open", true)], 101),
        ok(json!([changed_file()])),
    ]);
    let page = GiteeProvider
        .list_pull_requests_with_state(
            &ctx,
            PullRequestPagination {
                page: 1,
                per_page: 10,
            },
            ReviewPlatformListState::Draft,
        )
        .await
        .unwrap();
    assert_eq!(page.items[0].id, "101");
    assert_eq!(page.pagination.total, Some(1));
    assert!(!page.pagination.has_next);
    let scanned_requests = requests(receiver);
    assert_eq!(scanned_requests.len(), 3);
    assert_stat_requests(&scanned_requests[2..], &["101"]);

    let (ctx, receiver) = server(vec![counted_page(Vec::new(), 101)]);
    assert!(matches!(
        GiteeProvider
            .list_pull_requests_with_state(
                &ctx,
                PullRequestPagination {
                    page: 1,
                    per_page: 10
                },
                ReviewPlatformListState::Draft,
            )
            .await,
        Err(ReviewPlatformError::Parse(_))
    ));
    assert_eq!(requests(receiver).len(), 1);
}

#[test]
fn legacy_capabilities_round_trip_without_requiring_state_filters() {
    let remote = parse_remote(
        "origin",
        "https://gitee.com/example/repo.git",
        &ReviewPlatformAuthTokens::default(),
    )
    .unwrap();
    let capabilities = capabilities_for_remote(&remote);
    assert!(capabilities
        .supported_pull_request_states
        .contains(&ReviewPlatformListState::Merged));
    let mut legacy = serde_json::to_value(capabilities).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("supportedPullRequestStates");
    let decoded: ReviewPlatformCapabilities = serde_json::from_value(legacy.clone()).unwrap();
    assert!(decoded.supported_pull_request_states.is_empty());
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
}

#[tokio::test]
async fn draft_filter_reports_scan_exhaustion_instead_of_a_false_empty_repository() {
    let (ctx, receiver) = server(
        (0..MAX_REVIEW_TARGET_PAGES)
            .map(|page| {
                counted_page(
                    (1..=100)
                        .map(|id| numbered_pr(page as u32 * 100 + id, "open", false))
                        .collect(),
                    1001,
                )
            })
            .collect(),
    );
    assert!(matches!(
        GiteeProvider
            .list_pull_requests_with_state(
                &ctx,
                PullRequestPagination {
                    page: 1,
                    per_page: 10
                },
                ReviewPlatformListState::Draft,
            )
            .await,
        Err(ReviewPlatformError::EvidenceTooLarge { .. })
    ));
    assert_eq!(requests(receiver).len(), MAX_REVIEW_TARGET_PAGES);
}

#[tokio::test]
async fn prepared_diff_is_bound_to_stable_base_and_head() {
    let (ctx, receiver) = server(vec![ok(pr()), ok(json!([changed_file()])), ok(pr())]);
    let diff = GiteeProvider
        .pull_request_file_diff(&ctx, "69", BASE, HEAD, "src/old.rs", Some(99))
        .await
        .unwrap();
    assert!(diff
        .diff
        .starts_with("diff --git a/src/old.rs b/src/new.rs"));
    assert_eq!(diff.head_revision, HEAD);
    let captured = requests(receiver);
    assert_eq!(
        captured[1].url.path(),
        "/api/v5/repos/example/repo/pulls/69/files"
    );
    assert!(!captured[1].url.query_pairs().any(|(key, _)| key == "page"));

    let mut moved = pr();
    moved["head"]["sha"] = json!("3".repeat(40));
    let (ctx, receiver) = server(vec![ok(pr()), ok(json!([changed_file()])), ok(moved)]);
    let error = GiteeProvider
        .pull_request_review_target(&ctx, "69")
        .await
        .unwrap_err();
    assert!(matches!(error, ReviewPlatformError::StaleTarget(_)));
    requests(receiver);
}

#[tokio::test]
async fn section_failure_is_not_an_empty_successful_file_list() {
    let (ctx, receiver) = server(vec![
        ok(pr()),
        Response {
            status: 403,
            body: "{}".to_string(),
            headers: vec![],
        },
    ]);
    let result = GiteeProvider
        .pull_request_detail_page(
            &ctx,
            "69",
            ReviewPlatformDetailSection::Files,
            PullRequestPagination {
                page: 1,
                per_page: 20,
            },
        )
        .await;
    assert!(matches!(
        result,
        Err(ReviewPlatformError::Http { status: 403, .. })
    ));
    requests(receiver);
}

#[tokio::test]
async fn checks_use_global_pr_id_and_keep_output_separate_from_execution_logs() {
    let check = json!({"id":12,"head_sha":HEAD,"name":"unit tests","status":"completed","conclusion":"failure","output":{"summary":"Tests failed","text":"error: check failed"}});
    let (ctx, receiver) = server(vec![
        ok(json!({"total_count":1,"check_runs":[check.clone()]})),
        ok(pr()),
        ok(check),
    ]);
    let (checks, page) = checks_page(
        &ctx,
        &pull_request(&pr()).unwrap(),
        "10031905",
        PullRequestPagination {
            page: 1,
            per_page: 20,
        },
    )
    .await
    .unwrap();
    assert_eq!(page.total, Some(1));
    assert_eq!(summarize_ci_items(&checks).failed, 1);
    let log = GiteeProvider
        .pull_request_ci_log(&ctx, "69", "gitee-check:12", "unit tests")
        .await
        .unwrap();
    assert_eq!(log.log.as_deref(), Some("error: check failed"));
    assert!(log
        .message
        .unwrap()
        .contains("not complete CI execution logs"));
    let requests = requests(receiver);
    assert!(requests[0]
        .url
        .query_pairs()
        .any(|(k, v)| k == "pull_request_id" && v == "10031905"));
    assert!(requests[0].url.path().contains(HEAD));
}

#[tokio::test]
async fn create_preserves_fork_head_and_draft_without_extra_mutations() {
    let (ctx, receiver) = server(vec![ok(pr())]);
    let result = GiteeProvider
        .create_pull_request(
            &ctx,
            &ReviewPlatformCreatePullRequestRequest {
                workspace_id: None,
                repository_path: "unused".into(),
                remote_id: None,
                title: "A change".into(),
                source_branch: "fork/repo:feature".into(),
                target_branch: "main".into(),
                body: Some("Details".into()),
                draft: Some(true),
            },
        )
        .await
        .unwrap();
    assert!(result.success);
    let request = requests(receiver).remove(0);
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.body,
        json!({"title":"A change","head":"fork/repo:feature","base":"main","body":"Details","draft":true})
    );
}

fn approval(body: Option<&str>) -> ReviewPlatformApprovalRequest {
    ReviewPlatformApprovalRequest {
        workspace_id: None,
        repository_path: "unused".into(),
        remote_id: "origin".into(),
        pull_request_id: "69".into(),
        body: body.map(str::to_string),
    }
}

#[tokio::test]
async fn approval_reports_partial_success_and_never_uses_admin_force() {
    let (ctx, receiver) = server(vec![
        Response {
            status: 201,
            body: String::new(),
            headers: vec![],
        },
        Response {
            status: 403,
            body: "{}".into(),
            headers: vec![],
        },
    ]);
    let result = GiteeProvider
        .approve_pull_request(&ctx, &approval(Some("Looks good")))
        .await
        .unwrap();
    assert!(!result.success);
    assert!(result.message.contains("approval succeeded"));
    assert!(result.message.contains("Retry only submit_review"));
    let requests = requests(receiver);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body, json!({"force":false}));
    assert_eq!(requests[1].body, json!({"body":"Looks good"}));
}

#[tokio::test]
async fn revocation_resets_only_the_current_review_and_unsupported_writes_fail_closed() {
    let (ctx, receiver) = server(vec![ok(json!({}))]);
    assert!(
        GiteeProvider
            .revoke_approval(&ctx, &approval(None))
            .await
            .unwrap()
            .success
    );
    let request = requests(receiver).remove(0);
    assert_eq!(request.method, "PATCH");
    assert_eq!(
        request.url.path(),
        "/api/v5/repos/example/repo/pulls/69/assignees"
    );
    assert_eq!(request.body, json!({"reset_all":false}));
    let capabilities = capabilities_for_remote(&ctx.remote);
    assert!(
        capabilities.can_approve
            && capabilities.can_revoke_approval
            && capabilities.can_create_pull_request
    );
    assert!(
        !capabilities.can_reply_to_thread
            && !capabilities.can_resolve_thread
            && !capabilities.can_request_changes
            && !capabilities.can_merge
            && !capabilities.supports_draft_review
    );
    assert!(GiteeProvider
        .submit_review(
            &ctx,
            &ReviewPlatformSubmitReviewRequest {
                workspace_id: None,
                repository_path: "unused".into(),
                remote_id: "origin".into(),
                pull_request_id: "69".into(),
                event: ReviewSubmitEvent::RequestChanges,
                body: "Needs changes".into(),
            }
        )
        .await
        .is_err());
    assert!(pull_url(&ctx, "69/merge").is_err());
}

#[tokio::test]
async fn gitee_credentials_do_not_change_the_legacy_store_and_survive_other_updates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tokens.json");
    let service = ReviewPlatformService::new_local_only(path.clone());
    service
        .update_auth_token(ReviewPlatformKind::Gitlab, "gitlab.com", "old-token")
        .await
        .unwrap();
    let legacy = fs::read(&path).await.unwrap();
    service
        .update_auth_token(ReviewPlatformKind::Gitee, "GITEE.COM.", "new-token")
        .await
        .unwrap();
    assert_eq!(fs::read(&path).await.unwrap(), legacy);
    let sidecar = fs::read(path.with_extension("gitee.json")).await.unwrap();
    service
        .update_auth_token(ReviewPlatformKind::Gitcode, "gitcode.com", "another-token")
        .await
        .unwrap();
    assert_eq!(
        fs::read(path.with_extension("gitee.json")).await.unwrap(),
        sidecar
    );
    let reopened = ReviewPlatformService::new_local_only(path.clone());
    let tokens = reopened.load_stored_tokens().await.unwrap();
    assert_eq!(
        tokens.get(ReviewPlatformKind::Gitee, "gitee.com"),
        Some("new-token")
    );
    assert_eq!(
        tokens.get(ReviewPlatformKind::Gitlab, "gitlab.com"),
        Some("old-token")
    );
    assert!(reopened
        .update_auth_token(ReviewPlatformKind::Gitee, "untrusted.example", "never-send")
        .await
        .is_err());
    reopened
        .clear_auth_token(ReviewPlatformKind::Gitee, "gitee.com")
        .await
        .unwrap();
    assert_eq!(
        reopened
            .load_stored_tokens()
            .await
            .unwrap()
            .get(ReviewPlatformKind::Gitee, "gitee.com"),
        None
    );
    fs::write(path.with_extension("gitee.json"), b"unreadable")
        .await
        .unwrap();
    assert!(reopened.load_stored_tokens().await.is_err());
    assert_eq!(
        fs::read(path.with_extension("gitee.json")).await.unwrap(),
        b"unreadable"
    );
}

#[tokio::test]
async fn issue_numbers_remain_strings_and_comments_keep_pagination_evidence() {
    let identity = ProviderIssueIdentity::new(
        ReviewPlatformKind::Gitee,
        "gitee.com",
        "example/repo",
        "IABC12",
    )
    .unwrap();
    assert!(ProviderIssueIdentity::new(
        ReviewPlatformKind::Gitee,
        "gitee.com",
        "example/repo",
        "IABC12/../user"
    )
    .is_err());
    let mut comments = ok(json!([{"id":12,"body":"Comment","user":{"login":"reviewer"}}]));
    comments.headers.push(("total_count", "2".into()));
    let (ctx, receiver) = server(vec![
        ok(json!({"number":"IABC12","title":"Issue","body":"Description","state":"open"})),
        comments,
    ]);
    let plan = issue_request_plan(
        &ctx,
        &identity,
        IssuePagination {
            page: 1,
            per_page: 1,
        },
    )
    .unwrap();
    let evidence = acquire_issue_evidence(&ctx, &identity, &plan)
        .await
        .unwrap();
    assert_eq!(evidence.issue_id, "IABC12");
    assert_eq!(evidence.next_cursor.as_deref(), Some("2"));
    assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
    assert_eq!(evidence.comments.len(), 1);
    let requests = requests(receiver);
    assert_eq!(
        requests[0].url.path(),
        "/api/v5/repos/example/repo/issues/IABC12"
    );
}

#[tokio::test]
async fn transport_errors_do_not_expose_query_credentials() {
    let request = authenticate(
        http_client().unwrap().get("http://127.0.0.1:0/private"),
        Some("sensitive-test-value"),
    );
    let error = send_json(request).await.unwrap_err().to_string();
    assert!(!error.contains("sensitive-test-value"));
    assert!(!error.contains("access_token"));
}

#[test]
fn legacy_detail_payloads_default_limitations_and_round_trip_without_new_fields() {
    let mut legacy = serde_json::to_value(pull_request(&pr()).unwrap()).unwrap();
    let object = legacy.as_object_mut().unwrap();
    object.insert("body".into(), json!("Description"));
    for key in ["ci", "files", "commits", "threads"] {
        object.insert(key.into(), json!([]));
    }
    let detail: ReviewPlatformPullRequestDetail = serde_json::from_value(legacy.clone()).unwrap();
    assert!(detail.limitations.is_empty());
    assert_eq!(serde_json::to_value(detail).unwrap(), legacy);
}

#[tokio::test]
async fn missing_head_keeps_overview_readable_but_cannot_start_exact_review() {
    let mut value = pr();
    value["head"] = Value::Null;
    let (ctx, receiver) = server(vec![
        ok(value.clone()),
        ok(json!([changed_file()])),
        ok(value.clone()),
    ]);
    let overview = GiteeProvider
        .pull_request_detail_page(
            &ctx,
            "69",
            ReviewPlatformDetailSection::Overview,
            PullRequestPagination {
                page: 1,
                per_page: 20,
            },
        )
        .await
        .unwrap();
    assert_eq!(overview.pull_request.title, "Fix hooks");
    assert!(overview
        .limitations
        .contains(&"provider_ci_head_unavailable".to_string()));
    assert_eq!(requests(receiver).len(), 3);
    let (ctx, receiver) = server(vec![ok(value)]);
    assert!(GiteeProvider
        .pull_request_review_target(&ctx, "69")
        .await
        .is_err());
    assert_eq!(requests(receiver).len(), 1);
}

#[tokio::test]
#[ignore = "Read-only smoke test against the public Gitee API; requires network access"]
async fn public_gitee_initial_list_statistics() {
    let mut ctx = provider_context_for_identity(
        ReviewPlatformKind::Gitee,
        "gitee.com",
        "dromara/sa-token",
        &ReviewPlatformAuthTokens::default(),
    )
    .unwrap();
    ctx.token = std::env::var("GITEE_TOKEN").ok();
    for state in [
        ReviewPlatformListState::All,
        ReviewPlatformListState::Open,
        ReviewPlatformListState::Draft,
        ReviewPlatformListState::Merged,
        ReviewPlatformListState::Closed,
    ] {
        let page = GiteeProvider
            .list_pull_requests_with_state(
                &ctx,
                PullRequestPagination {
                    page: 1,
                    per_page: 2,
                },
                state,
            )
            .await
            .unwrap();
        for pr in &page.items {
            // Compare initial list data against an independent raw files read;
            // do not call a detail loader or reuse the file/statistics mapper.
            let response = send_bounded_json(
                get(&ctx, &format!("{}/files", pull_url(&ctx, &pr.id).unwrap())).unwrap(),
            )
            .await
            .unwrap();
            let values = response.as_array().unwrap();
            if values.len() >= FILE_LIMIT {
                assert!(!pr.changed_file_count_known);
                assert_eq!(pr.line_stats_known, Some(false));
                println!(
                    "Initial Gitee list {state:?} #{}: capped file response, totals unknown",
                    pr.number
                );
                continue;
            }
            let sum = |key: &str| -> i32 {
                values
                    .iter()
                    .map(|file| {
                        let value = &file[key];
                        value
                            .as_i64()
                            .unwrap_or_else(|| value.as_str().unwrap().parse().unwrap())
                    })
                    .sum::<i64>()
                    .try_into()
                    .unwrap()
            };
            assert!(pr.changed_file_count_known);
            assert_eq!(pr.line_stats_known, Some(true));
            assert_eq!(pr.changed_files as usize, values.len());
            assert_eq!(pr.additions, sum("additions"));
            assert_eq!(pr.deletions, sum("deletions"));
            println!(
                "Initial Gitee list {state:?} #{}: {} files, +{}, -{}",
                pr.number, pr.changed_files, pr.additions, pr.deletions
            );
        }
    }
}

#[tokio::test]
#[ignore = "Read-only smoke test against the public Gitee API; requires network access"]
async fn public_gitee_readonly_smoke() {
    let mut ctx = provider_context_for_identity(
        ReviewPlatformKind::Gitee,
        "gitee.com",
        "openeuler/go-gitee",
        &ReviewPlatformAuthTokens::default(),
    )
    .unwrap();
    ctx.token = None;
    let target = GiteeProvider
        .pull_request_review_target(&ctx, "69")
        .await
        .unwrap();
    assert_eq!(target.pull_request.id, "69");
    assert_eq!(target.pull_request.provider_id, None);
    let file = target
        .files
        .iter()
        .find(|file| file.diff_available)
        .expect("Public sample should contain a text diff");
    let diff = GiteeProvider
        .pull_request_file_diff(
            &ctx,
            "69",
            target.pull_request.base_revision.as_deref().unwrap(),
            target.pull_request.head_revision.as_deref().unwrap(),
            &file.path,
            None,
        )
        .await
        .unwrap();
    assert!(diff.diff.starts_with("diff --git "));
    let ci = GiteeProvider
        .pull_request_detail_page(
            &ctx,
            "69",
            ReviewPlatformDetailSection::Ci,
            PullRequestPagination {
                page: 1,
                per_page: 20,
            },
        )
        .await
        .unwrap();
    assert_eq!(ci.pull_request.id, "69");
    let detail = GiteeProvider.pull_request_detail(&ctx, "69").await.unwrap();
    assert_eq!(detail.pull_request.id, "69");
    assert!(!detail.commits.is_empty());
    assert!(detail.commits.iter().all(|commit| !commit.hash.is_empty()));
    assert_eq!(detail.files.len(), target.files.len());
}
