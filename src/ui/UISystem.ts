import { System } from "../ecs";

interface UIWidget {
  id: string;
  element: HTMLElement;
  update?: (dt: number) => void;
}

export class UISystem extends System {
  priority = 950;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private overlay: HTMLElement;
  private widgets = new Map<string, UIWidget>();

  constructor(overlayId: string = "ui-overlay") {
    super();
    this.overlay = document.getElementById(overlayId) ?? document.body;
  }

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
