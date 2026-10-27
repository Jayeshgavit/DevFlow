use serde::Serialize;
use std::{io, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

pub const MAX_LINE_BYTES: usize = 16 * 1024;
const MAX_BATCH_BYTES: usize = 64 * 1024;
const MAX_BATCH_LINES: usize = 128;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine { pub message: String, pub sequence: u64, pub received_at: u64 }

// Bound both the reader and event rate. Backpressure blocks the owned producer's
// pipe, never Stop's process lock, and no distinct output is silently dropped.
pub async fn collect<R: AsyncRead + Unpin>(pipe: R, mut publish: impl FnMut(Vec<OutputLine>)) -> io::Result<()> {
    let mut reader = BufReader::new(pipe);
    let mut line = Vec::with_capacity(1024);
    let mut omitted = 0usize;
    let mut pending = Vec::new();
    let mut bytes = 0usize;
    let mut sequence = 0u64;
    let mut deadline = tokio::time::Instant::now() + FLUSH_INTERVAL;
    loop {
        let chunk = if pending.is_empty() { reader.fill_buf().await } else {
            match tokio::time::timeout_at(deadline, reader.fill_buf()).await {
                Ok(result) => result,
                Err(_) => {
                    publish(std::mem::take(&mut pending)); bytes = 0;
                    deadline = tokio::time::Instant::now() + FLUSH_INTERVAL;
                    continue;
                }
            }
        };
        let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    if !line.is_empty() {
                        sequence += 1;
                        pending.push(OutputLine { message: format!("{} [incomplete: output read failed; {omitted} bytes omitted]", String::from_utf8_lossy(&line)), sequence, received_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 });
                    }
                    if !pending.is_empty() { publish(pending); }
                    return Err(error);
                }
        };
        let eof = chunk.is_empty();
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(chunk.len(), |index| index + 1);
        let data = &chunk[..newline.unwrap_or(consumed)];
        let kept = data.len().min(MAX_LINE_BYTES.saturating_sub(line.len()));
        line.extend_from_slice(&data[..kept]);
        omitted = omitted.saturating_add(data.len() - kept);
        reader.consume(consumed);
        if newline.is_some() || (eof && (!line.is_empty() || omitted > 0)) {
            let mut message = String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(&line)).into_owned();
            if omitted > 0 { message.push_str(&format!(" [truncated: {omitted} bytes omitted]")); }
            bytes += message.len();
            sequence += 1;
            pending.push(OutputLine { message, sequence, received_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 });
            line.clear(); omitted = 0;
        }
        if eof { if !pending.is_empty() { publish(pending); } return Ok(()); }
        if pending.len() >= MAX_BATCH_LINES || bytes >= MAX_BATCH_BYTES {
            tokio::time::sleep_until(deadline).await;
            publish(std::mem::take(&mut pending)); bytes = 0;
            deadline = tokio::time::Instant::now() + FLUSH_INTERVAL;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flood_batches_preserve_every_line_sequence_and_final_partial_line() {
        tauri::async_runtime::block_on(async {
            let data = format!("{}final partial", "ValueError: repeated\n".repeat(1000));
            let mut rows = Vec::new(); let mut batches = 0;
            collect(data.as_bytes(), |batch| { assert!(batch.len() <= MAX_BATCH_LINES); batches += 1; rows.extend(batch); }).await.unwrap();
            assert!(batches < 20); assert_eq!(rows.len(), 1001);
            assert_eq!(rows.last().unwrap().message, "final partial");
            for (index, row) in rows.iter().enumerate() { assert_eq!(row.sequence, index as u64 + 1); }
        });
    }
    #[test]
    fn oversized_line_is_bounded_and_truncation_is_explicit() {
        tauri::async_runtime::block_on(async {
            let data = vec![b'x'; MAX_LINE_BYTES * 4]; let mut rows = Vec::new();
            collect(data.as_slice(), |batch| rows.extend(batch)).await.unwrap();
            assert_eq!(rows.len(), 1); assert!(rows[0].message.len() < MAX_LINE_BYTES + 100);
            assert!(rows[0].message.contains("49152 bytes omitted"));
        });
    }
}
