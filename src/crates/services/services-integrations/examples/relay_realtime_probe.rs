//! Source-built transport probe used by the cross-machine Relay experiment.
//! Credentials are read from the environment and never printed.
use anyhow::{anyhow, Context, Result};
use openbitfun_services_integrations::remote_connect::realtime_client::{
    Incoming, RealtimeConnection,
};
use serde_json::json;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let role = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow!("Expected host or controller"))?;
    let url = std::env::var("RELAY_LAB_URL")?;
    let token = std::env::var("RELAY_LAB_TOKEN")?;
    #[cfg(feature = "remote-ssh-concrete")]
    if role == "seed-saved-ssh" {
        use openbitfun_services_integrations::remote_ssh::{
            SSHConnectionConfig, SSHConnectionManager,
        };
        let data = std::path::PathBuf::from(std::env::var("RELAY_LAB_SSH_DATA")?);
        let fixture = std::env::var("RELAY_LAB_SSH_FIXTURE")?;
        let manager = SSHConnectionManager::new(data);
        manager.load_saved_connections().await?;
        let config: SSHConnectionConfig = serde_json::from_value(
            json!({"id":"relay-lab-saved-ssh","name":"Isolated relay SSH fixture","host":"127.0.0.1","port":19703,"username":"root","auth":{"type":"PrivateKey","keyPath":format!("{fixture}/client_key"),"passphrase":null},"defaultWorkspace":std::env::var("RELAY_LAB_WORKSPACE")?}),
        )?;
        manager.save_connection(&config).await?;
        let public = std::fs::read_to_string(format!("{fixture}/host_key.pub"))?;
        let key = russh_keys::parse_public_key_base64(
            public
                .split_whitespace()
                .nth(1)
                .ok_or_else(|| anyhow!("Missing lab public key"))?,
        )?;
        manager
            .add_known_host(config.host, config.port, &key)
            .await?;
        println!("Saved isolated SSH profile via the owning SSHConnectionManager");
        return Ok(());
    }
    if role == "seed-test-host" {
        use openbitfun_services_integrations::remote_connect::{device_crypto, session_store};
        let home = std::path::PathBuf::from(std::env::var("RELAY_LAB_HOME")?);
        if home.exists() && std::fs::read_dir(&home)?.next().is_some() {
            return Err(anyhow!("Lab seed requires an empty, isolated home"));
        }
        session_store::set_session_store_directory_for_test(home);
        // Deliberately public fixture key, NEVER an application credential.
        session_store::save_session_with_device(
            &token,
            "realtime-lab",
            &[7; 32],
            &url,
            Some(&std::env::var("RELAY_LAB_TARGET")?),
        )?;
        println!("{}", device_crypto::public_key_base64(&[7; 32]));
        println!("{}", device_crypto::public_key_base64(&[11; 32]));
        return Ok(());
    }
    if role == "product-session-start" || role == "product-session-recover" {
        use openbitfun_services_integrations::remote_connect::{
            account::{AccountClient, AccountSession},
            host_stream_subscriber::{HostStreamSubscriber, SessionEvent},
        };
        use std::sync::{Arc, Mutex};
        let account = AccountSession::new(token, "realtime-lab".into(), [11; 32]);
        let client = AccountClient::new();
        let target = std::env::var("RELAY_LAB_TARGET")?;
        let session_id = std::env::var("RELAY_LAB_SESSION")?;
        let workspace = std::env::var("RELAY_LAB_WORKSPACE")?;
        let invoke = |command: &'static str, request: serde_json::Value| {
            let (client, account, url, target) = (&client, &account, &url, &target);
            async move {
                let response:serde_json::Value=serde_json::from_str(&client.device_rpc(url,account,target,&json!({"cmd":"host_invoke","command":command,"args":{"request":request}}).to_string()).await?)?;
                if response["ok"] != true {
                    return Err(anyhow!("{command} failed: {}", response["error"]));
                }
                Ok(response["value"].clone())
            }
        };
        if role == "product-session-start" {
            invoke("open_workspace", json!({"path":workspace})).await?;
            invoke("create_session",json!({"sessionId":session_id,"sessionName":"Isolated relay record runtime experiment","agentType":"Standard","workspacePath":workspace,"config":{"modelName":"relay-record-fixture"}})).await?;
        }
        let records = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let output = records.clone();
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let failure = errors.clone();
        let mut subscriber = HostStreamSubscriber::start(
            account.clone(),
            url.clone(),
            target.clone(),
            session_id.clone(),
            Arc::new(move |event: SessionEvent| {
                if event.event == "session-record" {
                    output.lock().unwrap().push(event.payload);
                }
                Ok(())
            }),
            Arc::new(move |error| {
                failure.lock().unwrap().push(error);
            }),
        )
        .await?;
        if role == "product-session-start" {
            invoke("start_dialog_turn",json!({"sessionId":session_id,"turnId":format!("{session_id}-turn"),"agentType":"Standard","workspacePath":workspace,"userInput":"Relay record lab: read fixture.txt, then confirm completion. This is an isolated protocol experiment."})).await?;
        }
        let start = std::time::Instant::now();
        loop {
            let values = records.lock().unwrap().clone();
            let tool = values.iter().any(|value| {
                value["item"]["type"] == "tool" && value["item"]["data"]["toolResult"].is_object()
            });
            let final_text = values.iter().any(|value| {
                value["item"]["type"] == "text"
                    && value["item"]["data"]["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("RELAY_RECORD_FINAL"))
            });
            let completed = values
                .iter()
                .any(|value| value["turn"]["status"] == "completed");
            if tool && (role == "product-session-start" || final_text && completed) {
                println!("Runtime session records verified: phase={role} records={} tool_completed={tool} final_text={final_text} turn_completed={completed} elapsed_ms={}",values.len(),start.elapsed().as_millis());
                println!("Lab session: {session_id}");
                subscriber.close();
                return Ok(());
            }
            if start.elapsed() > std::time::Duration::from_secs(90) {
                return Err(anyhow!("Runtime journal verification timed out: records={}, errors={:?}, tool={tool}, final={final_text}, complete={completed}",values.len(),errors.lock().unwrap()));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    if role == "product-controller" {
        use openbitfun_services_integrations::remote_connect::account::{
            AccountClient, AccountSession,
        };
        let session = AccountSession::new(token, "realtime-lab".into(), [11; 32]);
        let client = AccountClient::new();
        for _ in 0..20 {
            let response = client
                .device_rpc(
                    &url,
                    &session,
                    &std::env::var("RELAY_LAB_TARGET")?,
                    r#"{"cmd":"ping"}"#,
                )
                .await?;
            let response: serde_json::Value = serde_json::from_str(&response)?;
            if response["resp"] != "pong" {
                return Err(anyhow!("Product Ping returned unexpected response"));
            }
        }
        println!("20 encrypted product Ping calls verified through the real host dispatcher");
        return Ok(());
    }
    if role == "product-features"
        || role == "product-upload"
        || role == "product-ssh-features"
        || role == "product-catalog"
        || role == "product-workspace-scopes"
    {
        use openbitfun_services_integrations::remote_connect::account::{
            AccountClient, AccountSession,
        };
        let session = AccountSession::new(token, "realtime-lab".into(), [11; 32]);
        let client = AccountClient::new();
        let target = std::env::var("RELAY_LAB_TARGET")?;
        let root = std::env::var("RELAY_LAB_WORKSPACE")?;
        let invoke = |command: &'static str, request: serde_json::Value| {
            let client = &client;
            let session = &session;
            let url = &url;
            let target = &target;
            async move {
                let message =
                    json!({"cmd":"host_invoke","command":command,"args":{"request":request}})
                        .to_string();
                let response: serde_json::Value = serde_json::from_str(
                    &client
                        .device_rpc(url, session, target, &message)
                        .await
                        .with_context(|| format!("Lab HostInvoke {command} failed"))?,
                )?;
                if response["ok"] != true {
                    return Err(anyhow!(
                        "Host operation {command} failed: {}",
                        response["error"]
                    ));
                }
                Ok::<_, anyhow::Error>(response["value"].clone())
            }
        };
        if role == "product-workspace-scopes" {
            let before = invoke("get_current_workspace", json!({})).await?;
            let listing = invoke("get_directory_children_paginated", json!({"path":"/","workspacePath":root,"remoteConnectionId":"relay-lab-saved-ssh","offset":0,"limit":100})).await?;
            if !listing["children"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
            {
                return Err(anyhow!("Saved SSH root listing empty"));
            }
            let after = invoke("get_current_workspace", json!({})).await?;
            if before != after {
                return Err(anyhow!("Saved SSH browse changed active workspace"));
            }
            let mut created = Vec::new();
            for name in ["scope-a", "scope-b"] {
                let workspace = format!("{root}/{name}");
                invoke(
                    "create_directory",
                    json!({"path":workspace,"workspacePath":root,"remoteConnectionId":""}),
                )
                .await?;
                invoke("write_file_content", json!({"filePath":format!("{workspace}/binding.txt"),"workspacePath":workspace,"remoteConnectionId":"","content":"binding"})).await?;
                let command = json!({"cmd":"create_session","agent_type":"Claw","session_name":"Explicit workspace probe","workspace_path":workspace}).to_string();
                let reply: serde_json::Value = serde_json::from_str(
                    &client.device_rpc(&url, &session, &target, &command).await?,
                )?;
                if reply["resp"] != "session_created" || reply["workspace_path"] != workspace {
                    return Err(anyhow!("Explicit Claw create wrong workspace: {reply}"));
                }
                let id = reply["session_id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Missing session id"))?
                    .to_owned();
                let rows = invoke(
                    "list_persisted_sessions",
                    json!({"workspacePath":workspace,"remoteConnectionId":""}),
                )
                .await?;
                if !rows
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["sessionId"] == id))
                {
                    return Err(anyhow!(
                        "Created session was not persisted in selected workspace"
                    ));
                }
                let read =
                    json!({"cmd":"get_file_info","path":"binding.txt","session_id":id}).to_string();
                let file_reply: serde_json::Value = serde_json::from_str(
                    &client.device_rpc(&url, &session, &target, &read).await?,
                )?;
                if file_reply["resp"] != "file_info" || file_reply["size"] != 7 {
                    return Err(anyhow!("Fresh session file binding failed: {file_reply}"));
                }
                created.push((workspace, id));
            }
            println!("Workspace scopes PASS: saved SSH root browse preserved active workspace; two Claw sessions persisted at their selected roots with resolvable file bindings");
            for (workspace, id) in created {
                invoke(
                    "delete_session",
                    json!({"workspacePath":workspace,"sessionId":id}),
                )
                .await?;
            }
            return Ok(());
        }
        if role == "product-catalog" {
            use openbitfun_services_integrations::remote_connect::{
                host_stream::HOST_CATALOG_ID,
                host_stream_subscriber::{HostStreamSubscriber, SessionEvent},
            };
            use std::sync::{Arc, Mutex};
            let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
            let output = events.clone();
            let errors = Arc::new(Mutex::new(Vec::<String>::new()));
            let failure = errors.clone();
            let mut subscriber = HostStreamSubscriber::start(
                session.clone(),
                url.clone(),
                target.clone(),
                HOST_CATALOG_ID.into(),
                Arc::new(move |event: SessionEvent| {
                    if event.event == "host-catalog-changed" {
                        output.lock().unwrap().push(event.payload);
                    }
                    Ok(())
                }),
                Arc::new(move |error| failure.lock().unwrap().push(error)),
            )
            .await?;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            while events.lock().unwrap().is_empty() {
                if tokio::time::Instant::now() > deadline {
                    return Err(anyhow!(
                        "Initial catalog stream missing: {:?}",
                        errors.lock().unwrap()
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            let before = events.lock().unwrap().last().unwrap()["workspacesRevision"]
                .as_u64()
                .unwrap();
            invoke("open_workspace", json!({"path":root})).await?;
            wait_catalog_revision(&events, "workspacesRevision", before).await?;
            let id = uuid::Uuid::new_v4().to_string();
            for (command, request) in [
                (
                    "create_session",
                    json!({"sessionId":id,"sessionName":"Catalog mutation fixture","agentType":"Standard","workspacePath":root}),
                ),
                (
                    "rename_session",
                    json!({"sessionId":id,"sessionName":"Renamed catalog fixture","workspacePath":root}),
                ),
                (
                    "delete_session",
                    json!({"sessionId":id,"workspacePath":root}),
                ),
            ] {
                let before = events.lock().unwrap().last().unwrap()["sessionsRevision"]
                    .as_u64()
                    .unwrap();
                invoke(command, request).await?;
                wait_catalog_revision(&events, "sessionsRevision", before).await?;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let count = events.lock().unwrap().len();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if events.lock().unwrap().len() != count {
                return Err(anyhow!("Idle catalog emitted redundant invalidations"));
            }
            subscriber.close();
            if !errors.lock().unwrap().is_empty() {
                return Err(anyhow!(
                    "Catalog subscription errors: {:?}",
                    errors.lock().unwrap()
                ));
            }
            println!("Runtime catalog stream PASS: workspace open, session create/rename/delete notifications, idle silence; events={count}");
            return Ok(());
        }
        if role == "product-ssh-features" {
            let profiles = invoke("ssh_list_saved_connections", json!({})).await?;
            if !profiles.as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|profile| profile["id"] == "relay-lab-saved-ssh")
            }) {
                return Err(anyhow!("Runtime saved SSH profile was not listed"));
            }
            let workspace = invoke(
                "open_remote_workspace",
                json!({"remotePath":root,"connectionId":"relay-lab-saved-ssh"}),
            )
            .await?;
            println!(
                "Remote workspace opened from runtime saved profile: {}",
                workspace["id"]
            );
        } else {
            invoke("create_directory", json!({"path":root})).await?;
        }
        if role == "product-upload" {
            use base64::Engine;
            use sha2::{Digest, Sha256};
            invoke("open_workspace", json!({"path":root})).await?;
            let total = 101 * 1024 * 1024usize;
            let chunk_size = 3 * 1024 * 1024usize;
            let chunk = (0..chunk_size)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            let mut hash = Sha256::new();
            for offset in (0..total).step_by(chunk_size) {
                hash.update(&chunk[..(total - offset).min(chunk_size)]);
            }
            let digest = format!("{:x}", hash.finalize());
            let transfer = (0..32)
                .map(|_| format!("{:02x}", rand::random::<u8>()))
                .collect::<String>();
            let path = format!("{root}/upload-101m-{transfer}.bin");
            let request = |action: &str| json!({"action":action,"transferId":transfer,"path":path,"workspacePath":root});
            let mut begin = request("begin");
            begin["totalBytes"] = json!(total);
            begin["sha256"] = json!(digest);
            invoke("workspace_file_upload", begin).await?;
            let start = std::time::Instant::now();
            for offset in (0..total).step_by(chunk_size) {
                let size = (total - offset).min(chunk_size);
                let mut append = request("append");
                append["offset"] = json!(offset);
                append["contentBase64"] =
                    json!(base64::engine::general_purpose::STANDARD.encode(&chunk[..size]));
                let result = invoke("workspace_file_upload", append.clone()).await?;
                if result["nextOffset"] != offset + size {
                    return Err(anyhow!("Upload cursor mismatch"));
                }
                if offset == 0 {
                    let duplicate = invoke("workspace_file_upload", append).await?;
                    if duplicate["nextOffset"] != size {
                        return Err(anyhow!("Duplicate chunk was not idempotent"));
                    }
                }
                if offset % (chunk_size * 7) == 0 {
                    let status = invoke("workspace_file_upload", request("status")).await?;
                    if status["nextOffset"] != offset + size {
                        return Err(anyhow!("Upload status mismatch"));
                    }
                }
            }
            let finished = invoke("workspace_file_upload", request("finish")).await?;
            if finished["completed"] != true || finished["nextOffset"] != total {
                return Err(anyhow!("Upload not completed"));
            }
            println!(
                "{}",
                json!({"bytes":total,"sha256":digest,"path":path,"elapsedMs":start.elapsed().as_millis(),"verified":"runtime hash checked; duplicate append and status verified"})
            );
            return Ok(());
        }
        let file = format!("{root}/bulk-fixture.txt");
        let renamed = format!("{root}/renamed-fixture.txt");
        let content = "fixture-content\n".repeat(200_000);
        if role == "product-ssh-features" {
            let transfer_work = async {
                use base64::Engine;
                use sha2::{Digest, Sha256};
                let transfer = (0..32)
                    .map(|_| format!("{:02x}", rand::random::<u8>()))
                    .collect::<String>();
                let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
                let request = |action: &str| json!({"action":action,"transferId":transfer,"path":file,"workspacePath":root,"remoteConnectionId":"relay-lab-saved-ssh"});
                let mut begin = request("begin");
                begin["totalBytes"] = json!(content.len());
                begin["sha256"] = json!(digest);
                invoke("workspace_file_upload", begin).await?;
                for (index, bytes) in content.as_bytes().chunks(3 * 1024 * 1024).enumerate() {
                    let mut chunk = request("append");
                    chunk["offset"] = json!(index * 3 * 1024 * 1024);
                    chunk["contentBase64"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(bytes));
                    invoke("workspace_file_upload", chunk).await?;
                }
                if invoke("workspace_file_upload", request("finish")).await?["completed"] != true {
                    return Err(anyhow!("Remote upload did not complete"));
                }
                let mut offset = 0usize;
                let mut downloaded = Sha256::new();
                let mut revision = None;
                while offset < content.len() {
                    let command=json!({"cmd":"read_file_chunk","path":file,"workspace_path":root,"remote_connection_id":"relay-lab-saved-ssh","offset":offset,"limit":3*1024*1024}).to_string();
                    let result: serde_json::Value = serde_json::from_str(
                        &client.device_rpc(&url, &session, &target, &command).await?,
                    )?;
                    if result["total_size"] != content.len() || result["offset"] != offset {
                        return Err(anyhow!("Remote download size/cursor mismatch: {result}"));
                    }
                    let current = result["revision"].clone();
                    if revision.as_ref().is_some_and(|old| old != &current) {
                        return Err(anyhow!("Remote download revision changed"));
                    }
                    revision = Some(current);
                    let bytes = base64::engine::general_purpose::STANDARD.decode(
                        result["chunk_base64"]
                            .as_str()
                            .ok_or_else(|| anyhow!("Missing remote file chunk"))?,
                    )?;
                    if bytes.is_empty() {
                        return Err(anyhow!("Remote download stalled"));
                    }
                    offset += bytes.len();
                    downloaded.update(bytes);
                }
                if format!("{:x}", downloaded.finalize()) != digest {
                    return Err(anyhow!("Remote download hash mismatch"));
                }
                Ok::<_, anyhow::Error>(())
            };
            let control_work = async {
                let mut times = Vec::new();
                for _ in 0..20 {
                    let start = std::time::Instant::now();
                    let result: serde_json::Value = serde_json::from_str(
                        &client
                            .device_rpc(&url, &session, &target, r#"{"cmd":"ping"}"#)
                            .await?,
                    )?;
                    if result["resp"] != "pong" {
                        return Err(anyhow!("Concurrent control Ping failed"));
                    }
                    times.push(start.elapsed().as_millis());
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                times.sort_unstable();
                Ok::<_, anyhow::Error>(
                    json!({"samples":times.len(),"p50Ms":times[times.len()/2],"maxMs":times.last()}),
                )
            };
            let (_, timings) = tokio::try_join!(transfer_work, control_work)?;
            println!("Concurrent control latency during SSH transfer: {timings}");
        } else {
            invoke(
                "write_file_content",
                json!({"filePath":file,"content":content}),
            )
            .await?;
        }
        let read = invoke("read_file_content", json!({"filePath":file})).await?;
        if read.as_str() != Some(content.as_str()) {
            return Err(anyhow!("File round-trip mismatch"));
        }
        invoke("rename_file", json!({"oldPath":file,"newPath":renamed})).await?;
        let children = invoke(
            "get_directory_children_paginated",
            json!({"path":root,"limit":100}),
        )
        .await?;
        if !children["children"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["name"] == "renamed-fixture.txt")
        }) {
            return Err(anyhow!("Renamed file missing from listing"));
        }
        invoke("delete_file", json!({"path":renamed})).await?;
        let profiles = invoke("ssh_list_saved_connections", json!({})).await?;
        if !profiles.is_array() {
            return Err(anyhow!("Saved connections response malformed"));
        }
        let terminal = format!("lab-{}", uuid::Uuid::new_v4());
        invoke(
            "terminal_create",
            json!({"sessionId":terminal,"workingDirectory":root,"cols":80,"rows":24}),
        )
        .await?;
        let check = async {
            let marker = format!("VERIFIED_{}", uuid::Uuid::new_v4());
            let encoded = marker
                .bytes()
                .map(|byte| format!("\\{:03o}", byte))
                .collect::<String>();
            invoke(
                "terminal_write",
                json!({"sessionId":terminal,"data":format!("printf '{}\\n'\n", encoded)}),
            )
            .await?;
            for _ in 0..30 {
                let history = invoke(
                    "terminal_get_history",
                    json!({"sessionId":terminal,"afterOffset":0}),
                )
                .await?;
                if history["data"]
                    .as_str()
                    .is_some_and(|data| data.contains(&marker))
                {
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(anyhow!("Terminal output missing"))
        }
        .await;
        let close = invoke("terminal_close", json!({"sessionId":terminal})).await;
        check?;
        close?;
        println!("{role}: large file write/read/rename/list/delete, saved connections, terminal create/write/history/close passed");
        return Ok(());
    }
    if role == "bulk-controller" {
        let connection = RealtimeConnection::connect(&url, &token, false).await?;
        let sender = connection.sender();
        let target = std::env::var("RELAY_LAB_TARGET")?;
        let content = "x".repeat(3 * 1024 * 1024);
        let bulk = sender.call(&target, json!({"content":content}));
        let controls = async {
            for i in 0..20 {
                let result = sender.call(&target, json!({"i":i})).await?;
                if result["echo"]["i"] != i {
                    return Err(anyhow!("Control correlation mismatch"));
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        let (bulk, _) = tokio::try_join!(bulk, controls)?;
        if bulk["echo"]["content"].as_str() != Some(content.as_str()) {
            return Err(anyhow!("Bulk payload mismatch"));
        }
        println!("3 MiB round-trip and 20 concurrent control calls verified");
        drop(sender);
        connection.close().await;
        return Ok(());
    }
    let mut connection = RealtimeConnection::connect(&url, &token, role == "host").await?;
    let sender = connection.sender();
    if role == "host" {
        println!("Source-built host registered");
        while let Ok(event) = connection.receive().await {
            if let Incoming::RpcRequest(request) = event {
                sender
                    .respond(request.id, json!({"echo":request.payload.0["params"]}))
                    .await?;
            }
        }
    } else {
        let target = std::env::var("RELAY_LAB_TARGET")?;
        let mut calls = Vec::new();
        for i in 0..20 {
            let sender = sender.clone();
            let target = target.clone();
            calls.push(async move {
                let result = sender.call(&target, json!({"i":i})).await?;
                if result["echo"]["i"] != i {
                    return Err(anyhow!("RPC correlation mismatch"));
                }
                Ok::<_, anyhow::Error>(())
            });
        }
        futures::future::try_join_all(calls).await?;
        println!("20 concurrent RPC calls verified");
    }
    drop(sender);
    connection.close().await;
    Ok(())
}

async fn wait_catalog_revision(
    events: &std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    field: &str,
    before: u64,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if events
            .lock()
            .unwrap()
            .last()
            .and_then(|event| event[field].as_u64())
            .is_some_and(|revision| revision > before)
        {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            return Err(anyhow!("Catalog {field} did not advance"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}
