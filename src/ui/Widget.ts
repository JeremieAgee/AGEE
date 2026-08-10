export interface UIStyle {
  x?: number;
  y?: number;
  width?: number | string;
  height?: number | string;
  flexDirection?: "row" | "column";
  justifyContent?: "start" | "center" | "end" | "between";
  alignItems?: "start" | "center" | "end" | "stretch";
  gap?: number;
  padding?: number;
  margin?: number;
  backgroundColor?: string;
  borderRadius?: number;
  border?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  opacity?: number;
  visible?: boolean;
  cursor?: string;
  overflow?: "visible" | "hidden" | "scroll";
  position?: "relative" | "absolute";
  zIndex?: number;
}

// Escapes text for safe interpolation into an HTML string. UISystem.addWidget() and
// UIManager.createWorldUI() both insert their `html` argument via innerHTML by design (widget
// content is meant to be real markup, not just plain text), so any untrusted value — a player
// display name, chat text, anything not authored by the game itself — must be run through this
// before being interpolated into that string, or it's an XSS vector.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared by UISystem and UIManager (see the "these are two independent stacks" note on each):
// both fall back to <body> when the configured overlay id isn't present in the DOM, and both
// used to re-implement this same one-liner independently. If a project ever does mix the two
// stacks against the same overlayId, they at least resolve to the exact same element via one
// code path instead of two copies that could silently drift.
export function resolveUIOverlay(overlayId: string): HTMLElement {
  return document.getElementById(overlayId) ?? document.body;
}

// AUDIT fix: DOM event forwarding used to be Button-specific (its createElement() was the
// only place that ever called emit()), so Panel/Label/ProgressBar/Image had a fully wired
// on()/emit() API that nothing ever fed — e.g. `panel.on("click", fn)` silently never fired.
// Every Widget subclass mounts through the same createElement()->this.element pattern, so
// the forwarding is hooked once here instead of duplicated per subclass. Kept to the common
// interactive DOM events rather than everything (e.g. no mousemove/wheel) to avoid needless
// per-frame listener overhead on widgets that don't need it.
const FORWARDED_DOM_EVENTS = ["click", "dblclick", "mousedown", "mouseup", "mouseenter", "mouseleave", "contextmenu"] as const;

export abstract class Widget {
  id: string;
  style: UIStyle;
  children: Widget[] = [];
  parent: Widget | null = null;
  element!: HTMLElement;
  private eventHandlers = new Map<string, Function[]>();

  constructor(id: string, style: UIStyle = {}) {
    this.id = id;
    this.style = style;
  }

  addChild(child: Widget): this {
    child.parent = this;
    this.children.push(child);
    if (this.element && child.element) {
      this.element.appendChild(child.element);
    }
    return this;
  }

  removeChild(child: Widget): this {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parent = null;
      child.element?.remove();
    }
    return this;
  }

  on(event: string, handler: Function): this {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event)!.push(handler);
    return this;
  }

  // AUDIT fix: previously fired only this widget's own handlers, so a click on a child never
  // reached a listener registered on an ancestor (`this.parent` existed but nothing walked
  // it). Bubbling unconditionally to the parent mirrors DOM bubbling semantics and matches
  // the "click on a child naturally reaches a parent listener" expectation — there's no
  // stopPropagation-equivalent concept elsewhere in this widget tree, so there's nothing to
  // gate it on.
  emit(event: string, ...args: any[]): void {
    this.eventHandlers.get(event)?.forEach((h) => h(...args));
    this.parent?.emit(event, ...args);
  }

  abstract createElement(): HTMLElement;

  private bindDomEvents(): void {
    for (const type of FORWARDED_DOM_EVENTS) {
      this.element.addEventListener(type, (e: Event) => {
        // Native DOM bubbling would otherwise walk up to ancestor widgets' own listeners
        // (they're real DOM children) AND emit()'s own parent-walk would bubble through the
        // widget tree — stopPropagation() here means the DOM event is translated into a
        // widget emit() exactly once, at the deepest widget, and emit() alone drives the
        // walk up to ancestors from there.
        e.stopPropagation();
        this.emit(type, e);
      });
    }
  }

  mount(parent: HTMLElement): void {
    this.element = this.createElement();
    this.element.id = `ui-${this.id}`;
    this.applyStyle();
    this.bindDomEvents();
    parent.appendChild(this.element);

    for (const child of this.children) {
      child.mount(this.element);
    }
  }

  unmount(): void {
    for (const child of this.children) {
      child.unmount();
    }
    this.element?.remove();
  }

  applyStyle(): void {
    if (!this.element) return;
    const s = this.element.style;
    const st = this.style;

    if (st.position) s.position = st.position;
    if (st.x !== undefined) s.left = `${st.x}px`;
    if (st.y !== undefined) s.top = `${st.y}px`;
    if (st.width !== undefined) s.width = typeof st.width === "number" ? `${st.width}px` : st.width;
    if (st.height !== undefined) s.height = typeof st.height === "number" ? `${st.height}px` : st.height;
    if (st.backgroundColor) s.backgroundColor = st.backgroundColor;
    if (st.borderRadius !== undefined) s.borderRadius = `${st.borderRadius}px`;
    if (st.border) s.border = st.border;
    if (st.color) s.color = st.color;
    if (st.fontSize !== undefined) s.fontSize = `${st.fontSize}px`;
    if (st.fontFamily) s.fontFamily = st.fontFamily;
    if (st.opacity !== undefined) s.opacity = `${st.opacity}`;
    if (st.visible === false) s.display = "none";
    if (st.padding !== undefined) s.padding = `${st.padding}px`;
    if (st.margin !== undefined) s.margin = `${st.margin}px`;
    if (st.gap !== undefined) s.gap = `${st.gap}px`;
    if (st.cursor) s.cursor = st.cursor;
    if (st.overflow) s.overflow = st.overflow;
    if (st.zIndex !== undefined) s.zIndex = `${st.zIndex}`;

    if (st.flexDirection || st.justifyContent || st.alignItems) {
      s.display = "flex";
      if (st.flexDirection) s.flexDirection = st.flexDirection;
      if (st.justifyContent) {
        const jcMap: Record<string, string> = {
          start: "flex-start", center: "center", end: "flex-end", between: "space-between",
        };
        s.justifyContent = jcMap[st.justifyContent] || st.justifyContent;
      }
      if (st.alignItems) {
        const aiMap: Record<string, string> = {
          start: "flex-start", center: "center", end: "flex-end", stretch: "stretch",
        };
        s.alignItems = aiMap[st.alignItems] || st.alignItems;
      }
    }
  }

  setVisible(visible: boolean): void {
    this.style.visible = visible;
    if (this.element) {
      this.element.style.display = visible ? "" : "none";
    }
  }
}

export class Panel extends Widget {
  createElement(): HTMLElement {
    const el = document.createElement("div");
    return el;
  }
}

export class Label extends Widget {
  text: string;

  constructor(id: string, text: string, style: UIStyle = {}) {
    super(id, style);
    this.text = text;
  }

  createElement(): HTMLElement {
    const el = document.createElement("span");
    el.textContent = this.text;
    return el;
  }

  setText(text: string): void {
    this.text = text;
    if (this.element) this.element.textContent = text;
  }
}

export class Button extends Widget {
  text: string;

  constructor(id: string, text: string, style: UIStyle = {}) {
    super(id, { cursor: "pointer", ...style });
    this.text = text;
  }

  createElement(): HTMLElement {
    const el = document.createElement("button");
    el.textContent = this.text;
    el.style.border = "none";
    el.style.outline = "none";
    // "click" forwarding is now handled generically by Widget.bindDomEvents() (see the
    // FORWARDED_DOM_EVENTS AUDIT fix note) — Button no longer needs its own listener.
    return el;
  }

  setText(text: string): void {
    this.text = text;
    if (this.element) this.element.textContent = text;
  }
}

export class ProgressBar extends Widget {
  value: number;
  max: number;
  barColor: string;
  private barEl?: HTMLElement;

  constructor(id: string, value: number, max: number, style: UIStyle = {}, barColor = "#4CAF50") {
    super(id, style);
    this.value = value;
    this.max = max;
    this.barColor = barColor;
  }

  createElement(): HTMLElement {
    const container = document.createElement("div");
    container.style.backgroundColor = "rgba(0,0,0,0.3)";
    container.style.borderRadius = "4px";
    container.style.overflow = "hidden";
    container.style.width = "100%";
    container.style.height = "100%";

    this.barEl = document.createElement("div");
    this.barEl.style.height = "100%";
    this.barEl.style.backgroundColor = this.barColor;
    this.barEl.style.transition = "width 0.2s";
    this.updateBar();
    container.appendChild(this.barEl);
    return container;
  }

  setValue(value: number): void {
    this.value = Math.max(0, Math.min(value, this.max));
    this.updateBar();
  }

  private updateBar(): void {
    if (this.barEl) {
      this.barEl.style.width = `${(this.value / this.max) * 100}%`;
    }
  }
}

export class Image extends Widget {
  src: string;

  constructor(id: string, src: string, style: UIStyle = {}) {
    super(id, style);
    this.src = src;
  }

  createElement(): HTMLElement {
    const el = document.createElement("img");
    el.src = this.src;
    el.style.objectFit = "contain";
    (el as HTMLImageElement).draggable = false;
    return el;
  }
}
