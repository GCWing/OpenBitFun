//! Engine.IO protocol task.

use crate::error::{EngineError, Error};
use crate::packet::{Frame, Handshake, Message, Packet};
use crate::transport::TransportStrategy;
use crate::websocket::WebSocketConnector;
use futures_util::{Sink, SinkExt, TryFutureExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;

/// Data exchanged between the engine task and its producers
#[derive(Debug)]
pub enum EngineAction {
    /// An inbound frame from the transport layer.
    Transport(Frame),
    /// An outbound message from the upper layer.
    Sink(Message),
}

impl From<Frame> for EngineAction {
    fn from(frame: Frame) -> Self {
        Self::Transport(frame)
    }
}

impl From<Message> for EngineAction {
    fn from(message: Message) -> Self {
        Self::Sink(message)
    }
}

/// Sends [`Frame`]s to the engine task (transport layer use).
#[derive(Clone, Debug)]
pub struct FrameSender(pub mpsc::Sender<EngineAction>);

impl FrameSender {
    /// Sends a [`Frame`] to the engine task.
    ///
    /// # Errors
    ///
    /// Returns an error if the engine task has exited.
    pub async fn send(&self, frame: Frame) -> Result<(), mpsc::error::SendError<EngineAction>> {
        self.0.send(EngineAction::Transport(frame)).await
    }
}

/// Sends [`Message`]s to the engine task (Socket.IO layer use).
#[derive(Clone, Debug)]
pub struct MessageSender(pub mpsc::Sender<EngineAction>);

impl MessageSender {
    /// Sends a [`Message`] to the engine task.
    ///
    /// # Errors
    ///
    /// Returns an error if the engine task has exited.
    pub async fn send(&self, message: Message) -> Result<(), mpsc::error::SendError<EngineAction>> {
        self.0.send(EngineAction::Sink(message)).await
    }
}

/// Drives the engine protocol and transport concurrently until the session ends.
///
/// `sink` receives decoded inbound [`Message`]s from the transport.
/// The caller creates the engine channel, retains the [`MessageSender`] half,
/// and passes the [`FrameSender`] and receiver here.
///
/// # Errors
///
/// Returns an error if either the engine or transport task fails.
#[allow(clippy::too_many_arguments)]
pub async fn connect<C, S>(
    url: Url,
    http_client: reqwest::Client,
    websocket_connector: C,
    strategy: TransportStrategy,
    sink: S,
    engine_rx: mpsc::Receiver<EngineAction>,
    frame_tx: FrameSender,
    transport_capacity: usize,
) -> Result<(), Error>
where
    C: WebSocketConnector,
    S: Sink<Message> + Unpin + Send + 'static,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let (transport_tx, transport_rx) = mpsc::channel(transport_capacity);

    let (handshake_tx, handshake_rx) = oneshot::channel();

    let token = CancellationToken::new();

    let eio_future = engine_io(sink, engine_rx, transport_tx, handshake_rx, token.clone());

    let transport_future = strategy.run(
        url,
        http_client,
        websocket_connector,
        handshake_tx,
        frame_tx,
        transport_rx,
        token,
    );

    tokio::try_join!(
        eio_future.map_err(Error::Engine),
        transport_future.map_err(Error::Transport),
    )?;

    Ok(())
}

struct Heartbeat {
    deadline: Instant,
    ping_window: std::time::Duration,
}

impl Heartbeat {
    fn new(ping_window: std::time::Duration) -> Self {
        Self {
            deadline: Instant::now() + ping_window,
            ping_window,
        }
    }

    fn reset(&mut self) {
        self.deadline = Instant::now() + self.ping_window;
    }
}

#[tracing::instrument(skip_all, err)]
async fn engine_io<S>(
    mut sink: S,
    mut engine_rx: mpsc::Receiver<EngineAction>,
    transport_tx: mpsc::Sender<Frame>,
    handshake_rx: oneshot::Receiver<Handshake>,
    token: CancellationToken,
) -> Result<(), EngineError>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    // Ensure the transport shuts down whenever the engine exits, regardless of the reason.
    let _guard = token.drop_guard();

    let handshake = handshake_rx.await?;
    tracing::debug!(sid = %handshake.sid, "<- OPEN");

    let mut heartbeat = Heartbeat::new(handshake.ping_window());

    while let Some(action) = tokio::time::timeout_at(heartbeat.deadline, engine_rx.recv()).await? {
        match action {
            EngineAction::Transport(frame) => match frame {
                Frame::Packet(packet) => {
                    tracing::trace!(%packet, "<- packet");

                    match packet {
                        Packet::Close => {
                            tracing::debug!("server closed");

                            // Release a manager blocked on outbound capacity
                            // before waiting for space in its inbound queue.
                            engine_rx.close();
                            // The Socket.IO manager still owns live namespace
                            // senders. Notify it before this task exits so its
                            // receivers close and the account owner can reconnect.
                            // A manager that already exited has nothing left to
                            // release, so a failed notification is not an error.
                            if let Err(error) = sink.send(Message::Close).await {
                                tracing::debug!(%error, "manager already closed");
                            }
                            break;
                        }
                        Packet::Ping(payload) => {
                            tracing::trace!("-> PONG");

                            transport_tx.send(Packet::Pong(payload).into()).await?;

                            heartbeat.reset();
                        }
                        Packet::Message(payload) => {
                            sink.send(Message::Text(payload))
                                .await
                                .map_err(|e| EngineError::SendSink(e.into()))?;
                        }
                        Packet::Noop => {}

                        packet => return Err(EngineError::Server(packet)),
                    }
                }
                Frame::Binary(payload) => {
                    tracing::trace!(bytes = payload.len(), "<- binary");

                    sink.send(Message::Binary(payload))
                        .await
                        .map_err(|e| EngineError::SendSink(e.into()))?;
                }
            },
            EngineAction::Sink(message) => match message {
                Message::Text(bytes) => {
                    let packet = Packet::Message(bytes);

                    tracing::trace!(%packet, "-> MESSAGE");

                    transport_tx.send(packet.into()).await?;
                }
                Message::Binary(bytes) => {
                    tracing::trace!(bytes = bytes.len(), "-> binary");

                    transport_tx.send(bytes.into()).await?;
                }
                Message::Close => {
                    tracing::debug!("client closed");
                    tracing::trace!("-> CLOSE");

                    transport_tx.send(Packet::Close.into()).await?;
                    break;
                }
            },
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use futures_util::{sink, Sink};
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};
    use tokio::sync::{mpsc, oneshot};
    use tokio_util::sync::CancellationToken;

    struct FailingSink;

    impl Sink<Message> for FailingSink {
        type Error = std::io::Error;

        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    fn make_handshake() -> Handshake {
        Handshake {
            sid: "sid".into(),
            upgrades: vec![],
            ping_interval: 25_000,
            ping_timeout: 5_000,
            max_payload: 1_000_000,
        }
    }

    struct Setup {
        tx: mpsc::Sender<EngineAction>,
        rx: mpsc::Receiver<EngineAction>,
        transport_tx: mpsc::Sender<Frame>,
        transport_rx: mpsc::Receiver<Frame>,
        handshake_rx: oneshot::Receiver<Handshake>,
    }

    fn setup() -> Setup {
        let (tx, rx) = mpsc::channel(4);
        let (transport_tx, transport_rx) = mpsc::channel(4);
        let (handshake_tx, handshake_rx) = oneshot::channel();
        handshake_tx.send(make_handshake()).unwrap();
        Setup {
            tx,
            rx,
            transport_tx,
            transport_rx,
            handshake_rx,
        }
    }

    impl Setup {
        async fn run(self) -> (Result<(), EngineError>, mpsc::Receiver<Frame>) {
            self.run_with(sink::drain()).await
        }

        async fn run_with<S>(self, sink: S) -> (Result<(), EngineError>, mpsc::Receiver<Frame>)
        where
            S: Sink<Message> + Unpin,
            S::Error: std::error::Error + Send + Sync + 'static,
        {
            let transport_rx = self.transport_rx;
            let result = engine_io(
                sink,
                self.rx,
                self.transport_tx,
                self.handshake_rx,
                CancellationToken::new(),
            )
            .await;
            (result, transport_rx)
        }
    }

    type CapturingSink = Pin<Box<dyn Sink<Message, Error = std::convert::Infallible> + Send>>;

    fn capturing_sink() -> (CapturingSink, Arc<Mutex<Vec<Message>>>) {
        let store = Arc::new(Mutex::new(Vec::<Message>::new()));
        let s = store.clone();
        let sink = Box::pin(sink::unfold(s, |s, msg: Message| async move {
            s.lock().unwrap().push(msg);
            Ok::<_, std::convert::Infallible>(s)
        }));
        (sink, store)
    }

    #[test]
    fn engine_action_from_frame() {
        let frame = Frame::Binary(Bytes::from_static(b"x"));
        let action = EngineAction::from(frame.clone());
        assert!(matches!(action, EngineAction::Transport(f) if f == frame));
    }

    #[test]
    fn engine_action_from_message() {
        let action = EngineAction::from(Message::Close);
        assert!(matches!(action, EngineAction::Sink(Message::Close)));
    }

    #[tokio::test]
    async fn frame_sender_wraps_frame_as_transport() {
        let (tx, mut rx) = mpsc::channel(4);
        let sender = FrameSender(tx);
        let frame = Frame::Binary(Bytes::from_static(b"x"));
        sender.send(frame.clone()).await.unwrap();
        assert!(matches!(rx.recv().await.unwrap(), EngineAction::Transport(f) if f == frame));
    }

    #[tokio::test]
    async fn message_sender_wraps_message_as_sink() {
        let (tx, mut rx) = mpsc::channel(4);
        let sender = MessageSender(tx);
        sender.send(Message::Close).await.unwrap();
        assert!(matches!(
            rx.recv().await.unwrap(),
            EngineAction::Sink(Message::Close)
        ));
    }

    #[tokio::test]
    async fn engine_io_handshake_dropped_is_error() {
        let (_, rx) = mpsc::channel(4);
        let (transport_tx, _) = mpsc::channel(4);
        let (handshake_tx, handshake_rx) = oneshot::channel::<Handshake>();
        drop(handshake_tx);
        let result = engine_io(
            sink::drain(),
            rx,
            transport_tx,
            handshake_rx,
            CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Err(EngineError::RecvHandshake(_))));
    }

    #[tokio::test]
    async fn engine_io_server_close_notifies_sink_and_exits_ok() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (sink, messages) = capturing_sink();
        let (result, _) = s.run_with(sink).await;
        result.unwrap();
        assert!(matches!(
            messages.lock().unwrap().as_slice(),
            [Message::Close]
        ));
    }

    #[tokio::test]
    async fn engine_io_server_close_tolerates_closed_manager() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (result, _) = s.run_with(FailingSink).await;
        result.unwrap();
    }

    #[tokio::test]
    async fn engine_io_server_close_releases_blocked_senders() {
        let (engine_tx, engine_rx) = mpsc::channel(1);
        engine_tx
            .send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (manager_tx, manager_rx) = mpsc::channel(1);
        manager_tx
            .send(Message::Text("queued directive".into()))
            .await
            .unwrap();
        let (transport_tx, _transport_rx) = mpsc::channel(1);
        let (handshake_tx, handshake_rx) = oneshot::channel();
        handshake_tx.send(make_handshake()).unwrap();

        // A manager processing outbound messages cannot drain its inbox until
        // the engine accepts the writes or reports that the session is closed.
        let manager = async move {
            if engine_tx
                .send(EngineAction::Sink(Message::Text("first write".into())))
                .await
                .is_ok()
            {
                engine_tx
                    .send(EngineAction::Sink(Message::Text("pending write".into())))
                    .await
                    .unwrap_err();
            }
            drop(manager_rx);
        };
        let engine = engine_io(
            tokio_util::sync::PollSender::new(manager_tx),
            engine_rx,
            transport_tx,
            handshake_rx,
            CancellationToken::new(),
        );
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(engine, manager)
        })
        .await
        .expect("server close must release pending writes even when the manager inbox is full");
    }

    #[tokio::test]
    async fn engine_io_engine_channel_closed_exits_ok() {
        let s = setup();
        drop(s.tx);
        let result = engine_io(
            sink::drain(),
            s.rx,
            s.transport_tx,
            s.handshake_rx,
            CancellationToken::new(),
        )
        .await;
        result.unwrap();
    }

    #[tokio::test]
    async fn engine_io_client_close_sends_close_packet() {
        let s = setup();
        s.tx.send(EngineAction::Sink(Message::Close)).await.unwrap();
        let (result, mut transport_rx) = s.run().await;
        result.unwrap();
        assert!(matches!(
            transport_rx.recv().await.unwrap(),
            Frame::Packet(Packet::Close)
        ));
    }

    #[tokio::test]
    async fn engine_io_ping_triggers_pong() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Ping(
            "probe".into(),
        ))))
        .await
        .unwrap();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (result, mut transport_rx) = s.run().await;
        result.unwrap();
        assert!(matches!(
            transport_rx.recv().await.unwrap(),
            Frame::Packet(Packet::Pong(p)) if p == "probe"
        ));
    }

    #[tokio::test]
    async fn engine_io_noop_is_ignored() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Noop)))
            .await
            .unwrap();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (result, _) = s.run().await;
        result.unwrap();
    }

    #[tokio::test]
    async fn engine_io_unexpected_packet_is_server_error() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Upgrade)))
            .await
            .unwrap();
        let (result, _) = s.run().await;
        assert!(matches!(result, Err(EngineError::Server(Packet::Upgrade))));
    }

    #[tokio::test]
    async fn engine_io_text_message_forwarded_to_sink() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Message(
            "hello".into(),
        ))))
        .await
        .unwrap();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (sink, store) = capturing_sink();
        let (result, _) = s.run_with(sink).await;
        result.unwrap();
        let msgs = store.lock().unwrap();
        assert!(matches!(&msgs[0], Message::Text(t) if t == "hello"));
    }

    #[tokio::test]
    async fn engine_io_binary_frame_forwarded_to_sink() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Binary(Bytes::from_static(
            b"bin",
        ))))
        .await
        .unwrap();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Close)))
            .await
            .unwrap();
        let (sink, store) = capturing_sink();
        let (result, _) = s.run_with(sink).await;
        result.unwrap();
        let msgs = store.lock().unwrap();
        assert!(matches!(&msgs[0], Message::Binary(b) if b.as_ref() == b"bin"));
    }

    #[tokio::test]
    async fn engine_io_outbound_text_sent_to_transport() {
        let s = setup();
        s.tx.send(EngineAction::Sink(Message::Text("out".into())))
            .await
            .unwrap();
        s.tx.send(EngineAction::Sink(Message::Close)).await.unwrap();
        let (result, mut transport_rx) = s.run().await;
        result.unwrap();
        assert!(matches!(
            transport_rx.recv().await.unwrap(),
            Frame::Packet(Packet::Message(m)) if m == "out"
        ));
    }

    #[tokio::test]
    async fn engine_io_outbound_binary_sent_to_transport() {
        let s = setup();
        s.tx.send(EngineAction::Sink(Message::Binary(Bytes::from_static(
            b"out",
        ))))
        .await
        .unwrap();
        s.tx.send(EngineAction::Sink(Message::Close)).await.unwrap();
        let (result, mut transport_rx) = s.run().await;
        result.unwrap();
        assert!(matches!(
            transport_rx.recv().await.unwrap(),
            Frame::Binary(b) if b.as_ref() == b"out"
        ));
    }

    #[tokio::test]
    async fn engine_io_heartbeat_timeout_fires() {
        let (tx, rx) = mpsc::channel(4);
        let (transport_tx, _transport_rx) = mpsc::channel(4);
        let (handshake_tx, handshake_rx) = oneshot::channel();
        handshake_tx
            .send(Handshake {
                sid: "sid".into(),
                upgrades: vec![],
                ping_interval: 1,
                ping_timeout: 1,
                max_payload: 1_000_000,
            })
            .unwrap();
        // tx is kept alive so recv() never returns None; heartbeat fires after 2ms.
        let result = engine_io(
            sink::drain(),
            rx,
            transport_tx,
            handshake_rx,
            CancellationToken::new(),
        )
        .await;
        drop(tx);
        assert!(matches!(result, Err(EngineError::HeartbeatTimeout(_))));
    }

    #[tokio::test]
    async fn engine_io_message_sink_error() {
        let s = setup();
        s.tx.send(EngineAction::Transport(Frame::Packet(Packet::Message(
            "x".into(),
        ))))
        .await
        .unwrap();
        let (result, _) = s.run_with(FailingSink).await;
        assert!(matches!(result, Err(EngineError::SendSink(_))));
    }
}
