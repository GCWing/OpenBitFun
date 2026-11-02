//! WebSocket transport for Engine.IO v4.

use crate::engine::FrameSender;
use crate::error::{TransportError, WebSocketError};
use crate::packet::{Frame, Handshake, Packet, PROBE};
use crate::ENGINE_IO_VERSION;
use bytestring::ByteString;
use futures_util::{Sink, SinkExt, Stream, StreamExt, TryStreamExt};
use std::future::Future;
use std::pin::Pin;
use std::task::{ready, Context, Poll};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Error as TungsteniteError;
use tokio_tungstenite::tungstenite::Message as WebSocketMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream};
use tracing::Instrument;
use url::Url;

/// A WebSocket connector that can open a stream from a [`Url`].
pub trait WebSocketConnector: Send + 'static {
    /// Opens a WebSocket connection for the provided [`Url`].
    fn connect(
        self,
        url: Url,
    ) -> impl Future<Output = Result<WebSocketStream, TungsteniteError>> + Send;
}

impl<F, Fut> WebSocketConnector for F
where
    F: FnOnce(Url) -> Fut + Send + 'static,
    Fut: Future<Output = Result<WebSocketStream, TungsteniteError>> + Send + 'static,
{
    fn connect(
        self,
        url: Url,
    ) -> impl Future<Output = Result<WebSocketStream, TungsteniteError>> + Send {
        self(url)
    }
}

/// Opens a plain `tokio-tungstenite` WebSocket connection with no custom TLS
/// or header configuration.
impl WebSocketConnector for () {
    async fn connect(self, url: Url) -> Result<WebSocketStream, TungsteniteError> {
        let (stream, _) = connect_async(url).await?;
        Ok(WebSocketStream(stream))
    }
}

/// Framed WebSocket stream that speaks [`Frame`] instead of raw [`WebSocketMessage`].
pub struct WebSocketStream(pub tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>);

/// Converts an inbound WebSocket text frame into a [`ByteString`] without copying.
fn bytestring_from_utf8_bytes(utf8: tokio_tungstenite::tungstenite::Utf8Bytes) -> ByteString {
    // SAFETY: `tungstenite::Utf8Bytes` guarantees the inner `Bytes` is valid UTF-8.
    unsafe { ByteString::from_bytes_unchecked(utf8.into()) }
}

impl Stream for WebSocketStream {
    type Item = Result<Frame, WebSocketError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            let frame = match ready!(self.0.poll_next_unpin(cx)) {
                Some(result) => match result {
                    Ok(message) => match message {
                        WebSocketMessage::Text(text) => {
                            tracing::trace!(bytes = text.len(), "<- TEXT");

                            let bytes = bytestring_from_utf8_bytes(text);
                            let packet = Packet::decode(&bytes)?;

                            Some(Ok(Frame::Packet(packet)))
                        }
                        WebSocketMessage::Binary(binary) => {
                            tracing::trace!(bytes = binary.len(), "<- BINARY");

                            Some(Ok(Frame::Binary(binary)))
                        }
                        WebSocketMessage::Close(_) => Some(Ok(Frame::Packet(Packet::Close))),
                        _ => continue,
                    },
                    Err(e) => Some(Err(e.into())),
                },
                None => None,
            };

            return Poll::Ready(frame);
        }
    }
}

impl Sink<Frame> for WebSocketStream {
    type Error = WebSocketError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0
            .poll_ready_unpin(cx)
            .map_err(WebSocketError::Tungstenite)
    }

    fn start_send(mut self: Pin<&mut Self>, frame: Frame) -> Result<(), Self::Error> {
        let message = match frame {
            Frame::Packet(packet) => {
                let text = packet.encode();

                tracing::trace!(bytes = text.len(), "-> TEXT");

                WebSocketMessage::text(text)
            }
            Frame::Binary(bytes) => {
                tracing::trace!(bytes = bytes.len(), "-> BINARY");

                WebSocketMessage::binary(bytes)
            }
        };
        self.0
            .start_send_unpin(message)
            .map_err(WebSocketError::Tungstenite)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0
            .poll_flush_unpin(cx)
            .map_err(WebSocketError::Tungstenite)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0
            .poll_close_unpin(cx)
            .map_err(WebSocketError::Tungstenite)
    }
}

/// Builds the WebSocket URL by converting the scheme and appending EIO/transport/sid parameters.
fn websocket_url(mut url: Url, sid: Option<&str>) -> Url {
    let scheme = match url.scheme() {
        "http" => Some("ws"),
        "https" => Some("wss"),
        _ => None,
    };

    if let Some(scheme) = scheme {
        let _ = url.set_scheme(scheme);
    }

    {
        let mut query = url.query_pairs_mut();

        query
            .append_pair("EIO", ENGINE_IO_VERSION)
            .append_pair("transport", "websocket");

        if let Some(sid) = sid {
            query.append_pair("sid", sid);
        }
    }

    url
}

impl WebSocketStream {
    /// Opens a [`WebSocketStream`], running the upgrade probe when `sid` is present.
    ///
    /// # Errors
    ///
    /// Returns an error if the connection or probe fails.
    pub async fn connect<C>(
        base_url: Url,
        sid: Option<&str>,
        connector: C,
    ) -> Result<Self, WebSocketError>
    where
        C: WebSocketConnector,
    {
        let url = websocket_url(base_url, sid);

        let span = tracing::debug_span!("connect", %url);

        let mut stream = connector.connect(url).instrument(span).await?;

        if sid.is_some() {
            stream.probe().await?;
        }

        Ok(stream)
    }

    /// Waits for the next frame, returning an error if the stream is closed.
    async fn recv(&mut self) -> Result<Frame, WebSocketError> {
        self.next()
            .await
            .ok_or(WebSocketError::Closed)
            .and_then(|r| r)
    }

    /// Sends a probe `Ping` and expects a matching `Pong`, confirming the WebSocket path is live.
    #[tracing::instrument(level = "debug", skip_all, err)]
    async fn probe(&mut self) -> Result<(), WebSocketError> {
        tracing::debug!("-> PING probe");

        self.send(Packet::Ping(PROBE).into()).await?;

        match self.recv().await? {
            Frame::Packet(Packet::Pong(payload)) if payload == PROBE => {
                tracing::debug!("<- PONG probe");
            }

            frame => return Err(WebSocketError::Probe(frame)),
        }

        Ok(())
    }

    /// Drives the WebSocket I/O loop until the stream or either channel closes.
    ///
    /// When `handshake_tx` is `Some`, reads the first `Open` frame and forwards the handshake
    /// (direct WebSocket transport). When `None`, sends `Upgrade` immediately (polling upgrade path).
    ///
    /// # Errors
    ///
    /// Returns an error if a transport or protocol failure occurs.
    #[tracing::instrument(skip_all, err)]
    pub async fn transport(
        mut self,
        handshake_tx: Option<oneshot::Sender<Handshake>>,
        frame_tx: FrameSender,
        mut transport_rx: mpsc::Receiver<Frame>,
    ) -> Result<(), TransportError> {
        if let Some(handshake_tx) = handshake_tx {
            let handshake = match self.recv().await? {
                Frame::Packet(Packet::Open(handshake)) => handshake,
                frame => return Err(TransportError::Open(frame)),
            };

            tracing::debug!(sid = %handshake.sid, "<- OPEN");

            handshake_tx
                .send(handshake)
                .map_err(TransportError::SendHandshake)?;
        } else {
            tracing::debug!("-> UPGRADE");

            self.send(Packet::Upgrade.into()).await?;
        }

        loop {
            tokio::select! {
                result = self.try_next() => {
                    let Some(frame) = result? else {
                        tracing::debug!("websocket stream closed");
                        break;
                    };

                    frame_tx.send(frame).await?;
                }

                option = transport_rx.recv() => {
                    let Some(frame) = option else {
                        tracing::debug!("transport channel closed");
                        break;
                    };

                    self.send(frame).await?;
                }
            };
        }

        self.close().await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::FrameSender;
    use bytes::Bytes;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot};
    use tokio_tungstenite::tungstenite::Message as WsMsg;
    use tokio_tungstenite::{accept_async, client_async, MaybeTlsStream};

    async fn ws_pair() -> (
        WebSocketStream,
        tokio_tungstenite::WebSocketStream<TcpStream>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            accept_async(tcp).await.unwrap()
        });
        let tcp = TcpStream::connect(addr).await.unwrap();
        let (ws, _) = client_async("ws://127.0.0.1/", MaybeTlsStream::Plain(tcp))
            .await
            .unwrap();
        let client = WebSocketStream(ws);
        let server = server_task.await.unwrap();
        (client, server)
    }

    #[test]
    fn websocket_url_http_becomes_ws() {
        let url = Url::parse("http://localhost:3000/socket.io/").unwrap();
        let ws = websocket_url(url, None);
        assert_eq!(ws.scheme(), "ws");
        let q = ws.query().unwrap();
        assert!(q.contains("EIO=4"));
        assert!(q.contains("transport=websocket"));
    }

    #[test]
    fn websocket_url_https_becomes_wss() {
        let url = Url::parse("https://example.com/socket.io/").unwrap();
        let ws = websocket_url(url, None);
        assert_eq!(ws.scheme(), "wss");
    }

    #[test]
    fn websocket_url_appends_sid() {
        let url = Url::parse("http://localhost/socket.io/").unwrap();
        let ws = websocket_url(url, Some("abc123"));
        assert!(ws.query().unwrap().contains("sid=abc123"));
    }

    #[test]
    fn websocket_url_no_sid_when_none() {
        let url = Url::parse("http://localhost/socket.io/").unwrap();
        let ws = websocket_url(url, None);
        assert!(!ws.query().unwrap().contains("sid="));
    }

    #[test]
    fn websocket_url_unknown_scheme_unchanged() {
        let url = Url::parse("ws://localhost/socket.io/").unwrap();
        let ws = websocket_url(url, None);
        assert_eq!(ws.scheme(), "ws");
    }

    #[test]
    fn bytestring_from_utf8_bytes_preserves_content() {
        use tokio_tungstenite::tungstenite::Utf8Bytes;
        let text = "hello world";
        let utf8 = Utf8Bytes::from(text);
        let bs = bytestring_from_utf8_bytes(utf8);
        assert_eq!(&*bs, text);
    }

    #[tokio::test]
    async fn stream_decodes_text_frame_as_packet() {
        let (mut client, mut server) = ws_pair().await;
        server.send(WsMsg::text("4hello")).await.unwrap();
        let frame = client.next().await.unwrap().unwrap();
        assert!(matches!(frame, Frame::Packet(Packet::Message(m)) if m == "hello"));
    }

    #[tokio::test]
    async fn stream_decodes_binary_frame() {
        let (mut client, mut server) = ws_pair().await;
        server.send(WsMsg::binary(b"data".as_ref())).await.unwrap();
        let frame = client.next().await.unwrap().unwrap();
        assert!(matches!(frame, Frame::Binary(b) if b.as_ref() == b"data"));
    }

    #[tokio::test]
    async fn stream_invalid_packet_id_is_error() {
        let (mut client, mut server) = ws_pair().await;
        server.send(WsMsg::text("9bad")).await.unwrap();
        client.next().await.unwrap().unwrap_err();
    }

    #[tokio::test]
    async fn sink_sends_packet_frame_as_text() {
        let (mut client, mut server) = ws_pair().await;
        client
            .send(Frame::Packet(Packet::Pong("probe".into())))
            .await
            .unwrap();
        let msg = server.next().await.unwrap().unwrap();
        assert_eq!(msg.to_text().unwrap(), "3probe");
    }

    #[tokio::test]
    async fn sink_sends_binary_frame() {
        let (mut client, mut server) = ws_pair().await;
        client
            .send(Frame::Binary(Bytes::from_static(b"raw")))
            .await
            .unwrap();
        let msg = server.next().await.unwrap().unwrap();
        assert!(msg.is_binary());
        assert_eq!(msg.into_data().as_ref(), b"raw");
    }

    #[tokio::test]
    async fn probe_succeeds_on_matching_pong() {
        let (mut client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let msg = server.next().await.unwrap().unwrap();
            assert_eq!(msg.to_text().unwrap(), "2probe");
            server.send(WsMsg::text("3probe")).await.unwrap();
        });
        client.probe().await.unwrap();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn probe_fails_on_wrong_frame() {
        let (mut client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let _ = server.next().await.unwrap().unwrap();
            server.send(WsMsg::text("4unexpected")).await.unwrap();
        });
        assert!(matches!(
            client.probe().await,
            Err(WebSocketError::Probe(_))
        ));
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn transport_no_handshake_sends_upgrade() {
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let msg = server.next().await.unwrap().unwrap();
            assert_eq!(msg.to_text().unwrap(), "5");
            while let Some(Ok(_)) = server.next().await {}
        });
        let (engine_tx, _) = mpsc::channel(4);
        let (_, transport_rx) = mpsc::channel::<Frame>(4);
        client
            .transport(None, FrameSender(engine_tx), transport_rx)
            .await
            .unwrap();
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn transport_with_handshake_reads_open_packet() {
        let open_text = r#"0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":5000,"maxPayload":1000000}"#;
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            server.send(WsMsg::text(open_text)).await.unwrap();
            while let Some(Ok(_)) = server.next().await {}
        });
        let (handshake_tx, handshake_rx) = oneshot::channel();
        let (engine_tx, _) = mpsc::channel(4);
        let (transport_tx, transport_rx) = mpsc::channel::<Frame>(4);
        drop(transport_tx);
        client
            .transport(Some(handshake_tx), FrameSender(engine_tx), transport_rx)
            .await
            .unwrap();
        assert_eq!(&*handshake_rx.await.unwrap().sid, "abc");
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn transport_with_handshake_non_open_is_error() {
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            server.send(WsMsg::text("4hello")).await.unwrap();
            while let Some(Ok(_)) = server.next().await {}
        });
        let (handshake_tx, _) = oneshot::channel();
        let (engine_tx, _) = mpsc::channel(4);
        let (_, transport_rx) = mpsc::channel::<Frame>(4);
        let result = client
            .transport(Some(handshake_tx), FrameSender(engine_tx), transport_rx)
            .await;
        assert!(matches!(result, Err(TransportError::Open(_))));
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn transport_with_handshake_dropped_receiver_is_error() {
        let open_text = r#"0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":5000,"maxPayload":1000000}"#;
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            server.send(WsMsg::text(open_text)).await.unwrap();
            while let Some(Ok(_)) = server.next().await {}
        });
        let (handshake_tx, handshake_rx) = oneshot::channel::<Handshake>();
        drop(handshake_rx);
        let (engine_tx, _) = mpsc::channel(4);
        let (_, transport_rx) = mpsc::channel::<Frame>(4);
        let result = client
            .transport(Some(handshake_tx), FrameSender(engine_tx), transport_rx)
            .await;
        assert!(matches!(result, Err(TransportError::SendHandshake(_))));
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn transport_forwards_server_frame_to_engine() {
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let _ = server.next().await; // consume Upgrade
            server.send(WsMsg::text("4data")).await.unwrap();
            let _ = server.close(None).await;
            while let Some(Ok(_)) = server.next().await {}
        });
        let (engine_tx, mut engine_rx) = mpsc::channel(4);
        // Keep transport_tx alive so the select always drains the WS stream first.
        let (transport_tx, transport_rx) = mpsc::channel::<Frame>(4);
        client
            .transport(None, FrameSender(engine_tx), transport_rx)
            .await
            .unwrap();
        drop(transport_tx);
        let action = engine_rx.recv().await.unwrap();
        assert!(
            matches!(action, crate::engine::EngineAction::Transport(Frame::Packet(Packet::Message(m))) if m == "data")
        );
        assert!(matches!(
            engine_rx.recv().await.unwrap(),
            crate::engine::EngineAction::Transport(Frame::Packet(Packet::Close))
        ));
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn transport_forwards_outbound_frame_to_server() {
        let (client, mut server) = ws_pair().await;
        let server_task = tokio::spawn(async move {
            let msg = server.next().await.unwrap().unwrap();
            assert_eq!(msg.to_text().unwrap(), "5");
            let msg = server.next().await.unwrap().unwrap();
            assert_eq!(msg.to_text().unwrap(), "4out");
            while let Some(Ok(_)) = server.next().await {}
        });
        let (engine_tx, _) = mpsc::channel(4);
        let (transport_tx, transport_rx) = mpsc::channel::<Frame>(4);
        transport_tx
            .send(Frame::Packet(Packet::Message("out".into())))
            .await
            .unwrap();
        drop(transport_tx);
        client
            .transport(None, FrameSender(engine_tx), transport_rx)
            .await
            .unwrap();
        server_task.await.unwrap();
    }
}
