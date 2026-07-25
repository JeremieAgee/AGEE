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

  emit(event: string, ...args: any[]): void {
    this.eventHandlers.get(event)?.forEach((h) => h(...args));
  }

  abstract createElement(): HTMLElement;

  mount(parent: HTMLElement): void {
    this.element = this.createElement();
    this.element.id = `ui-${this.id}`;
    this.applyStyle();
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
    el.addEventListener("click", () => this.emit("click"));
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
