// Formatting stays off the UI thread, including for responses near the byte cap.
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<string>) => void) | null; postMessage: (value: { text: string; json: boolean }) => void };
worker.onmessage = event => {
  try {
    const value: unknown = JSON.parse(event.data);
    const pending = [{ value, depth: 0 }]; let estimated = event.data.length; let nodes = 1;
    // Bound indentation expansion before stringify: deeply nested untrusted JSON
    // can otherwise expand a tiny input into hundreds of megabytes.
    while (pending.length) {
      const item = pending.pop()!;
      if (item.depth > 64 || estimated > 2 * 1024 * 1024) { worker.postMessage({ text: event.data, json: true }); return; }
      if (item.value && typeof item.value === 'object') {
        const children = Object.values(item.value); nodes += children.length;
        if (nodes > 100_000) { worker.postMessage({ text: event.data, json: true }); return; }
        estimated += children.length * (item.depth * 2 + 8);
        for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    const text = JSON.stringify(value, null, 2); worker.postMessage({ text: text.length <= 2 * 1024 * 1024 ? text : event.data, json: true });
  }
  catch { worker.postMessage({ text: event.data, json: false }); }
};
export {};
