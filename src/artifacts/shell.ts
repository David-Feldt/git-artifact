/**
 * The page a popup shows while its artifact is being written.
 *
 * Served instead of the artifact when none is cached yet. It starts the generation itself
 * and polls until there is something to show, which is what lets the click handler in the
 * app be nothing but `window.open` — and that matters, because a popup opened after an
 * `await` is a popup the browser blocks.
 *
 * Self-contained and hand-written rather than part of the client bundle: it has to render
 * instantly in a window that has loaded nothing else.
 */
export function renderShell(sha: string, subject: string): string {
  const short = escapeHtml(sha.slice(0, 7))
  const title = escapeHtml(subject || '(no message)')
  const shaJson = JSON.stringify(sha)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${short} — writing…</title>
<style>
  :root {
    color-scheme: light dark;
    --paper: #f5efe6; --card: #fdfbf7; --rule: #e3d9c9; --rule-strong: #d3c5ae;
    --ink: #2a2622; --ink-2: #6b6259; --ink-3: #9a8f83;
    --accent: #2a78d6; --danger: #b3261e;
    --ui: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
    --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #1b1917; --card: #23201d; --rule: #363029; --rule-strong: #4a4239;
      --ink: #ece5da; --ink-2: #b3a99c; --ink-3: #8a8075;
      --accent: #6ba6ea; --danger: #e07b72;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: var(--paper); color: var(--ink); font-family: var(--ui);
    font-size: 14px; line-height: 1.5; padding: 32px;
  }
  .box { max-width: 44ch; width: 100%; }
  .sha { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  h1 {
    margin: 6px 0 18px; font-size: 19px; font-weight: 620;
    letter-spacing: -0.012em; line-height: 1.3; text-wrap: balance;
  }
  .status { display: flex; align-items: center; gap: 9px; color: var(--ink-2); }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
  .elapsed { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .note {
    margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--rule);
    font-size: 12.5px; color: var(--ink-3);
  }
  .err { color: var(--danger); font-weight: 600; }
  .detail {
    margin-top: 10px; padding: 10px 12px; background: var(--card);
    border: 1px solid var(--rule); border-radius: 5px;
    font-family: var(--mono); font-size: 11.5px; color: var(--ink-2);
    white-space: pre-wrap; overflow-x: auto; max-height: 40vh;
  }
  button {
    font: inherit; font-size: 12.5px; margin-top: 14px; padding: 5px 12px;
    color: var(--ink); background: var(--card); border: 1px solid var(--rule-strong);
    border-radius: 5px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
</style>
</head>
<body>
<div class="box">
  <div class="sha">${short}</div>
  <h1>${title}</h1>
  <div id="state" class="status">
    <span class="dot"></span>
    <span>Writing this page…</span>
    <span class="elapsed" id="elapsed">0s</span>
  </div>
  <div class="note">
    Claude is reading the diff and everything git-artifact knows about this commit.
    Typically well under a minute. This window updates itself.
  </div>
</div>
<script>
(function () {
  var sha = ${shaJson};
  var started = Date.now();
  var elapsed = document.getElementById('elapsed');
  var state = document.getElementById('state');

  var tick = setInterval(function () {
    elapsed.textContent = Math.round((Date.now() - started) / 1000) + 's';
  }, 1000);

  function fail(message, detail) {
    clearInterval(tick);
    state.innerHTML = '';
    var line = document.createElement('div');
    line.className = 'err';
    line.textContent = message;
    state.appendChild(line);
    if (detail) {
      var pre = document.createElement('div');
      pre.className = 'detail';
      pre.textContent = detail;
      state.appendChild(pre);
    }
    var again = document.createElement('button');
    again.textContent = 'Try again';
    again.onclick = function () { location.reload(); };
    state.appendChild(again);
  }

  function poll() {
    fetch('/api/artifact?sha=' + encodeURIComponent(sha), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.state === 'ready') { clearInterval(tick); location.reload(); return; }
        if (s.state === 'error') { fail(s.message || 'Generation failed.', s.detail); return; }
        setTimeout(poll, 1500);
      })
      .catch(function () { setTimeout(poll, 2500); });
  }

  // Kick off generation, then watch for it. The daemon collapses concurrent requests for
  // the same commit into one run, so a reload of this window cannot start a second.
  fetch('/api/artifact?sha=' + encodeURIComponent(sha), {
    method: 'POST',
    credentials: 'same-origin',
  })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.state === 'ready') { clearInterval(tick); location.reload(); return; }
      if (s.state === 'error') { fail(s.message || 'Generation failed.', s.detail); return; }
      poll();
    })
    .catch(function (e) { fail('Could not reach the git-artifact daemon.', String(e)); });
}());
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
