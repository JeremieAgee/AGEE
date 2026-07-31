import { System } from "../ecs";
import { resolveUIOverlay } from "./Widget";

interface UIWidget {
  id: string;
  element: HTMLElement;
  update?: (dt: number) => void;
}

// This is the widget system Engine wires up by default (`AGEE.ui`). It's a separate, simpler
// API from UIManager/Widget's retained-mode tree — the two don't share state or overlay
// lifecycle, so don't assume they compose.
export class UISystem extends System {
  priority = 950;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private overlay: HTMLElement;
  private widgets = new Map<string, UIWidget>();

  constructor(overlayId: string = "ui-overlay") {
    super();
    this.overlay = resolveUIOverlay(overlayId);
  }

  /**
   * `html` is inserted via innerHTML as-is. Any untrusted content interpolated into it (player
   * names, chat text, etc.) must be run through `escapeHtml()` from `./Widget` first, or this
   * is an XSS vector.
   */
  addWidget(
    id: string,
    html: string,
    style?: Partial<CSSStyleDeclaration>,
    updateFn?: (dt: number, el: HTMLElement) => void
  ): HTMLElement {
    if (this.widgets.has(id)) {
      return this.widgets.get(id)!.element;
    }

    const el = document.createElement("div");
    el.id = `ui-${id}`;
    el.innerHTML = html;

    if (style) {
      Object.assign(el.style, style);
    }

    this.overlay.appendChild(el);

    this.widgets.set(id, {
      id,
      element: el,
      update: updateFn ? (dt: number) => updateFn(dt, el) : undefined,
    });

    return el;
  }

  removeWidget(id: string): void {
    const widget = this.widgets.get(id);
    if (widget) {
      widget.element.remove();
      this.widgets.delete(id);
    }
  }

  getWidget(id: string): HTMLElement | undefined {
    return this.widgets.get(id)?.element;
  }

  update(dt: number): void {
    for (const widget of this.widgets.values()) {
      widget.update?.(dt);
    }
  }

  destroy(): void {
    for (const widget of this.widgets.values()) {
      widget.element.remove();
    }
    this.widgets.clear();
  }
}
