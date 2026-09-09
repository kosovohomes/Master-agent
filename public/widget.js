(function () {
  if (window.__agentosWidgetLoaded) return;
  window.__agentosWidgetLoaded = true;

  var script = document.currentScript;
  var tenant = script ? script.getAttribute("data-tenant") || "" : "";
  var brand = script ? script.getAttribute("data-brand") || "Support" : "Support";
  var base = script ? script.getAttribute("data-base") || "" : "";

  var style = document.createElement("style");
  style.textContent =
    "#agentos-widget-toggle{position:fixed;right:20px;bottom:20px;z-index:99999;width:56px;height:56px;border-radius:50%;background:#1f2937;color:#fff;border:0;cursor:pointer;font-size:22px;box-shadow:0 4px 12px rgba(0,0,0,.2)}" +
    "#agentos-widget-panel{position:fixed;right:20px;bottom:84px;z-index:99999;width:min(360px,calc(100vw - 40px));height:440px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;display:none;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,.15);font-family:-apple-system,Segoe UI,Roboto,sans-serif}" +
    "#agentos-widget-head{padding:12px 16px;background:#1f2937;color:#fff;border-radius:12px 12px 0 0;font-weight:600;display:flex;justify-content:space-between;align-items:center}" +
    "#agentos-widget-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}" +
    "#agentos-widget-close{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}" +
    ".aos-msg{max-width:80%;padding:8px 12px;border-radius:10px;line-height:1.4;font-size:14px;word-wrap:break-word}" +
    ".aos-user{align-self:flex-end;background:#1f2937;color:#fff}" +
    ".aos-bot{align-self:flex-start;background:#f3f4f6;color:#111}" +
    "#agentos-widget-input{display:flex;gap:8px;border-top:1px solid #e5e7eb;padding:8px}" +
    "#agentos-widget-input input{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:8px;font-size:14px}" +
    "#agentos-widget-input button{border:0;border-radius:8px;background:#1f2937;color:#fff;padding:8px 12px;cursor:pointer}" +
    ".aos-src{font-size:11px;color:#6b7280;margin-top:4px}";
  document.head.appendChild(style);

  var toggle = document.createElement("button");
  toggle.id = "agentos-widget-toggle";
  toggle.textContent = "\uD83D\uDCAC";
  toggle.title = "Chat with us";
  document.body.appendChild(toggle);

  var panel = document.createElement("div");
  panel.id = "agentos-widget-panel";

  var head = document.createElement("div");
  head.id = "agentos-widget-head";
  var title = document.createElement("span");
  title.textContent = brand + " assistant";
  var close = document.createElement("button");
  close.id = "agentos-widget-close";
  close.innerHTML = "&times;";
  head.appendChild(title);
  head.appendChild(close);

  var body = document.createElement("div");
  body.id = "agentos-widget-body";
  var bubble = document.createElement("div");
  bubble.className = "aos-msg aos-bot";
  bubble.textContent = "Hello, how can we help?";
  body.appendChild(bubble);

  var inputWrap = document.createElement("div");
  inputWrap.id = "agentos-widget-input";
  var input = document.createElement("input");
  input.placeholder = "Type a question\u2026";
  var send = document.createElement("button");
  send.textContent = "Send";
  inputWrap.appendChild(input);
  inputWrap.appendChild(send);

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(inputWrap);
  document.body.appendChild(panel);

  function addMsg(text, who) {
    var el = document.createElement("div");
    el.className = "aos-msg " + (who === "user" ? "aos-user" : "aos-bot");
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function ask() {
    var q = input.value.trim();
    if (!q) return;
    input.value = "";
    addMsg(q, "user");
    if (!tenant) { addMsg("Widget not configured (data-tenant missing).", "bot"); return; }
    fetch(base + "/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: Number(tenant), question: q }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var el = addMsg(j && j.data && j.data.answer ? j.data.answer : "Sorry, I couldn't answer that.", "bot");
        if (j && j.data && j.data.sources && j.data.sources.length) {
          var src = document.createElement("div");
          src.className = "aos-src";
          src.textContent = "Source: " + j.data.sources[0].title;
          el.appendChild(src);
        }
      })
      .catch(function () { addMsg("Network error; please try again.", "bot"); });
  }

  send.addEventListener("click", ask);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });

  toggle.addEventListener("click", function () {
    panel.style.display = panel.style.display === "flex" ? "none" : "flex";
  });
  close.addEventListener("click", function () { panel.style.display = "none"; });
})();