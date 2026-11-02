# Engine.IO integration patches

Source: crates.io `eioc` 0.5.0, from <https://github.com/Stanley5249/sioc-rs>.
This copy retains the upstream MIT / Apache-2.0 license choice.

In Cargo.toml, `rustls-tls` enables
`reqwest/rustls-no-provider` instead of `reqwest/rustls`.
OpenBitFun selects ring through its existing TLS provider owner. Upstream's
Reqwest feature otherwise forces AWS-LC alongside ring, even when the Socket.IO
client receives OpenBitFun's configured HTTP client. Remove this TLS patch when
provider-neutral Rustls is available.

Connection closure is also forwarded through both protocol layers. WebSocket
Close frames become Engine.IO Close packets, and the engine sends
`Message::Close` to the Socket.IO manager before exiting. Previously a normal
server close could leave namespace receivers waiting forever, preventing the
account connection owner from reconnecting and publishing device presence.
The engine closes its inbound queue before notifying the manager so pending
outbound writes cannot deadlock the close notification under backpressure.
If the manager has already exited, the failed notification is logged at debug
level and the server close still completes normally.
Wire formats and the existing reconnect policy are unchanged.

The focused product regression command is:

```bash
cargo test --locked -p openbitfun-services-integrations --no-default-features --features remote-connect --lib remote_connect::relay_client::tests::server_close_reconnects_and_restores_device_presence
```
