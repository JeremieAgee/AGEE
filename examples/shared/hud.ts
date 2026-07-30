export interface HUDHandle {
  root: HTMLDivElement;
  setLine(id: string, text: string): void;
}

// Small fixed-position HUD panel (title, instructions, live stat lines) reused across examples
// so each example's main.ts only has to describe its own controls/stats, not build DOM chrome.
export function createHUD(title: string, instructions: string[]): HUDHandle {
  const root = document.createElement("div");
  root.className = "agee-hud";

  const backLink = document.createElement("a");
  backLink.className = "agee-hud-back";
  backLink.href = "/index.html";
  backLink.textContent = "← Examples";
  root.appendChild(backLink);

  const h1 = document.createElement("h1");
  h1.textContent = title;
  root.appendChild(h1);

  const ul = document.createElement("ul");
  for (const line of instructions) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.appendChild(li);
  }
  root.appendChild(ul);

  const stats = document.createElement("div");
  stats.className = "agee-hud-stats";
  root.appendChild(stats);

  document.body.appendChild(root);

  const lines = new Map<string, HTMLDivElement>();
  return {
    root,
    setLine(id: string, text: string): void {
      let el = lines.get(id);
      if (!el) {
        el = document.createElement("div");
        lines.set(id, el);
        stats.appendChild(el);
      }
      el.textContent = text;
    },
  };
}
