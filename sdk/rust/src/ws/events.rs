use std::pin::Pin;

use futures_util::StreamExt;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use crate::ws::protocol::EventFrame;

/// Create a filtered event stream that only yields events matching the given name.
///
/// Handles `BroadcastStreamRecvError::Lagged` by logging a warning and skipping.
pub fn filtered_event_stream(
    event_tx: &broadcast::Sender<EventFrame>,
    event_name: &str,
) -> Pin<Box<dyn futures_util::Stream<Item = EventFrame> + Send>> {
    let name = event_name.to_string();
    let rx = event_tx.subscribe();
    Box::pin(
        BroadcastStream::new(rx).filter_map(move |result| {
            let name = name.clone();
            async move {
                match result {
                    Ok(evt) if evt.event == name => Some(evt),
                    Ok(_) => None,
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                        tracing::warn!("event subscriber lagged, missed {n} events");
                        None
                    }
                }
            }
        }),
    )
}
