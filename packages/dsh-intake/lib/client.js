window.__ModuleLoader__.load({
  id: "crystra-execution-intake-internal",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const { Tooltip, IconCopyOutline16, writeClipboard } = require("@deepseek-ai/dsh-client-ui-primitives");
    const VERSION = "crystra.presentation@1.0.0";
    const KINDS = new Set([
      "command-accepted", "delivery-running", "delivery-list", "delivery-status",
      "action-output", "action-input-request", "terminal-result", "error",
    ]);
    const EMPTY_SESSION = Object.freeze({ chat: Object.freeze({ order: Object.freeze([]), nodes: new Map() }) });
    const subscribeEmpty = () => () => undefined;
    const readEmptySession = () => EMPTY_SESSION;
    const ANSWER_ACTIONS_STYLE = "crystra-execution-intake-internal/answer-actions";

    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(ANSWER_ACTIONS_STYLE)}]`) === null) {
      const style = document.createElement("style");
      style.dataset.plugin = "crystra-execution-intake-internal";
      style.dataset.pluginCss = ANSWER_ACTIONS_STYLE;
      style.textContent = ".crystra-answer-actions{align-items:center;gap:10px;height:28px;display:flex;margin-top:8px}.crystra-answer-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}.crystra-answer-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}";
      document.head.appendChild(style);
    }

    function invalidPresentation() {
      return { schemaVersion: VERSION, correlation: "presentation-invalid", kind: "error", data: {
        code: "CRYSTRA_PRESENTATION_INVALID", message: "Crystra presentation unavailable",
      } };
    }

    function parsePresentation(text) {
      if (typeof text !== "string" || text.length === 0 || text.length > 4096) return invalidPresentation();
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).sort().join(",") !== "correlation,data,kind,schemaVersion"
          || value.schemaVersion !== VERSION || typeof value.correlation !== "string" || value.correlation.length === 0
          || !KINDS.has(value.kind) || value.data === null || typeof value.data !== "object" || Array.isArray(value.data)) {
          return invalidPresentation();
        }
        return value;
      } catch {
        return invalidPresentation();
      }
    }

    function stringField(data, name) {
      return typeof data[name] === "string" ? data[name] : undefined;
    }

    function diagnosticFields(data) {
      const value = data?.diagnostic;
      return value !== null && typeof value === "object" && !Array.isArray(value)
        && typeof value.stage === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.stage)
        && typeof value.causeCode === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.causeCode)
        ? { stage: value.stage, causeCode: value.causeCode }
        : {};
    }

    function contentText(value) {
      if (typeof value === "string") return value;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const key of ["greeting", "message", "text", "summary", "result"]) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            const nested = contentText(value[key]);
            if (nested !== "Crystra content unavailable") return nested;
          }
        }
      }
      try { return JSON.stringify(value, null, 2); } catch { return "Crystra content unavailable"; }
    }

    function actionOutputText(value) {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        for (const item of value) {
          const completion = completionOutputText(item);
          if (completion !== "Crystra content unavailable") return completion;
        }
        const parts = value.flatMap((item) => {
          if (typeof item === "string") return item.length === 0 ? [] : [item];
          if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
          return item.type === "text" && typeof item.text === "string" && item.text.length > 0 ? [item.text] : [];
        });
        return parts.length === 0 ? "Crystra content unavailable" : parts.join("\n\n");
      }
      if (value === null || typeof value !== "object") return "Crystra content unavailable";
      if (typeof value.type === "string") return value.type === "text" && typeof value.text === "string"
        ? value.text
        : completionOutputText(value);
      for (const key of ["text", "message", "greeting", "summary", "result"]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const nested = actionOutputText(value[key]);
        if (nested !== "Crystra content unavailable") return nested;
      }
      return "Crystra content unavailable";
    }

    function completionOutputText(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)
        || value.type !== "tool-call" || value.name !== "workflow_complete" || typeof value.arguments !== "string") {
        return "Crystra content unavailable";
      }
      try {
        const args = JSON.parse(value.arguments);
        if (args === null || typeof args !== "object" || Array.isArray(args) || !("result" in args)) return "Crystra content unavailable";
        return actionOutputText(args.result);
      } catch { return "Crystra content unavailable"; }
    }

    function presentationText(event) {
      const data = event.data;
      if (event.kind === "command-accepted") return "Crystra command accepted";
      if (event.kind === "delivery-list") {
        if (!Array.isArray(data.items)) return "Crystra presentation unavailable";
        if (data.items.length === 0) return "No Workflow Deliveries";
        return `Workflow Deliveries (${data.items.length})\n${data.items.map((item) => {
          if (item === null || typeof item !== "object") return "Delivery";
          return [item.deliveryId, item.package, item.lifecycle].filter((part) => typeof part === "string").join(" · ") || "Delivery";
        }).join("\n")}`;
      }
      if (event.kind === "delivery-running") return `Workflow delivery running${stringField(data, "deliveryId") === undefined ? "" : ` · ${stringField(data, "deliveryId")}`}`;
      if (event.kind === "delivery-status") {
        const diagnostic = diagnosticFields(data);
        const status = data.created === false
          ? ["No new Workflow Delivery created", stringField(data, "reason"), stringField(data, "state")].filter(Boolean).join(" · ")
          : `Workflow delivery status${stringField(data, "state") === undefined ? "" : ` · ${stringField(data, "state")}`}`;
        return diagnostic.stage === undefined ? status : `${status}\nFailure stage: ${diagnostic.stage}\nCause: ${diagnostic.causeCode}`;
      }
      if (event.kind === "action-output") return `Action output\n${actionOutputText(data.content)}`;
      if (event.kind === "action-input-request") return `Action input requested\n${contentText(data.prompt)}`;
      if (event.kind === "terminal-result") return `Workflow finished${stringField(data, "outcome") === undefined ? "" : ` · ${stringField(data, "outcome")}`}`;
      return `${stringField(data, "code") ?? "CRYSTRA_ERROR"}: ${stringField(data, "message") ?? "Crystra presentation unavailable"}`;
    }

    function presentationElement(event, surface) {
      const chat = surface === "chat";
      const renderedText = presentationText(event);
      const copyText = event.kind === "action-output" ? actionOutputText(event.data.content) : undefined;
      const diagnostic = diagnosticFields(event.data);
      return React.createElement(chat ? "article" : "section", {
        "data-crystra-presentation": "true",
        "data-crystra-version": event.schemaVersion,
        "data-crystra-kind": event.kind,
        "data-crystra-correlation": event.correlation,
        "data-crystra-surface": surface,
        "data-crystra-state": stringField(event.data, "state"),
        "data-crystra-failure-stage": diagnostic.stage,
        "data-crystra-cause-code": diagnostic.causeCode,
        ...(chat ? { "data-crystra-chat-role": "assistant" } : {}),
        ...(surface === "sidebar" ? { "data-crystra-sidebar": "true" } : {}),
        role: event.kind === "error" ? "alert" : "status",
        style: chat ? { width: "100%", color: "inherit", lineHeight: 1.7 } : undefined,
      },
      React.createElement("div", { style: { margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" } }, renderedText),
      chat && copyText !== undefined && copyText !== "Crystra content unavailable"
        ? React.createElement("div", { className: "crystra-answer-actions", "data-crystra-answer-actions": "true" },
          React.createElement(Tooltip, { label: "复制", side: "bottom" },
            React.createElement("button", {
              type: "button",
              className: "crystra-answer-action",
              "aria-label": "复制",
              onClick: async () => { try { await writeClipboard(copyText); } catch { /* clipboard denial is non-fatal */ } },
            }, React.createElement(IconCopyOutline16, null))),
        )
        : null);
    }

    function CrystraCommandView() {
      return null;
    }

    const crystraInteractionDefinition = {
      kind: "crystra-interaction",
      target: "chat",
      match(event) {
        if (event?.type === "command/run" && event.data?.name === "crystra"
          && event.data?.source?.kind === "plugin" && event.data?.source?.plugin === "workflow-execution") {
          return { id: String(event.data.commandId), role: "start" };
        }
        return event?.type === "command/done"
          ? { id: String(event.data?.commandId), role: "update" }
          : null;
      },
      start(_context, match) {
        return { seq: match.event.seq, presentation: undefined };
      },
      update(context, match) {
        return { ...context.state, presentation: parsePresentation(match.event?.data?.text) };
      },
      buildViewNode(context) {
        if (context.state?.presentation === undefined) return null;
        return {
          key: context.key,
          kind: "crystra-interaction",
          id: context.id,
          target: "chat",
          anchorSeq: context.state.seq,
          location: context.start?.location ?? { kind: "unresolved" },
          visibility: "visible",
          data: context.state.presentation,
        };
      },
    };

    function CrystraInteractionView({ node }) {
      return presentationElement(node.data, "chat");
    }

    function latestCrystraQuery(snapshot, kind) {
      const order = snapshot?.chat?.order;
      const nodes = snapshot?.chat?.nodes;
      if (!Array.isArray(order) || typeof nodes?.get !== "function") return undefined;
      for (let index = order.length - 1; index >= 0; index -= 1) {
        const node = nodes.get(order[index]);
        if (node?.kind !== "command" || node.data?.name !== "crystra" || node.data?.outcome == null) continue;
        const event = parsePresentation(node.data.outcome.text);
        if (event.kind === kind || event.kind === "error") return event;
      }
      return undefined;
    }

    function createCrystraSidebar(ctx) {
      return function CrystraSidebar({ wide, useSessions }) {
        const [active, setActive] = React.useState("delivery-list");
        const sessionId = useSessions((state) => state.current);
        const session = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)?.session;
        const snapshot = React.useSyncExternalStore(
          session === undefined ? subscribeEmpty : (notify) => session.subscribe(notify),
          session === undefined ? readEmptySession : () => session.getSnapshot(),
          readEmptySession,
        );
        const event = latestCrystraQuery(snapshot, active);
        const diagnostic = event === undefined ? {} : diagnosticFields(event.data);
        const query = (kind, line) => async () => {
          setActive(kind);
          if (session !== undefined) await session.command(line);
        };
        return React.createElement("section", {
          "data-crystra-sidebar": "true",
          "data-crystra-surface": "sidebar",
          "data-crystra-presentation": event === undefined ? undefined : "true",
          "data-crystra-version": event?.schemaVersion,
          "data-crystra-kind": event?.kind ?? "idle",
          "data-crystra-correlation": event?.correlation,
          "data-crystra-state": event === undefined ? undefined : stringField(event.data, "state"),
          "data-crystra-failure-stage": diagnostic.stage,
          "data-crystra-cause-code": diagnostic.causeCode,
          role: event?.kind === "error" ? "alert" : "status",
        },
        React.createElement("button", { type: "button", onClick: query("delivery-list", "/crystra list") }, "Deliveries"),
        React.createElement("button", { type: "button", onClick: query("delivery-status", "/crystra status") }, "Current status"),
        React.createElement("pre", { style: { margin: 0, whiteSpace: "pre-wrap" } }, event === undefined ? (wide ? "Select a Crystra view" : "Crystra") : presentationText(event)));
      };
    }

    function apply(ctx) {
      ctx.conversationEvents.register(crystraInteractionDefinition);
      ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
        name: "conversation.chat.commandview",
        key: "crystra",
      }, CrystraCommandView));
      ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
        name: "conversation.chat.node",
        key: "crystra-interaction",
      }, CrystraInteractionView));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "workflow-execution",
        order: 50,
        label: "Crystra",
      }, createCrystraSidebar(ctx)));
    }

    exports.apply = apply;
    exports.inject = ["conversationEvents", "sessions", "slots"];
    exports.name = "workflow-execution-client";
    return module.exports;
  },
});
