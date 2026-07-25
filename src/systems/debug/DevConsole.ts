import { System, World } from "../../ecs";

export type CommandFn = (args: string[], world: World) => string | void;

export class DevConsole extends System {
  priority = 998;
  phase = "render" as const;

  private container!: HTMLDivElement;
  private input!: HTMLInputElement;
  private output!: HTMLDivElement;
  private visible = false;
  private commands = new Map<string, CommandFn>();
  private history: string[] = [];
  private historyIndex = -1;
  private maxLines = 200;

  private boundKeyHandler = this.onKeyDown.bind(this);

  registerCommand(name: string, fn: CommandFn): void {
    this.commands.set(name, fn);
  }

  unregisterCommand(name: string): void {
    this.commands.delete(name);
  }

  init(): void {
    this.registerBuiltins();
    this.createUI();
    document.addEventListener("keydown", this.boundKeyHandler);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? "flex" : "none";
    if (this.visible) {
      this.input.focus();
    } else {
      this.input.blur();
    }
  }

  show(): void {
    this.visible = true;
    this.container.style.display = "flex";
    this.input.focus();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = "none";
    this.input.blur();
  }

  log(text: string, color = "#ccc"): void {
    const line = document.createElement("div");
    line.style.color = color;
    line.textContent = text;
    this.output.appendChild(line);

    while (this.output.childElementCount > this.maxLines) {
      this.output.firstChild?.remove();
    }

    this.output.scrollTop = this.output.scrollHeight;
  }

  execute(cmd: string): void {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    this.history.push(trimmed);
    this.historyIndex = this.history.length;
    this.log(`> ${trimmed}`, "#4af");

    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    const args = parts.slice(1);

    const fn = this.commands.get(name);
    if (!fn) {
      this.log(`Unknown command: ${name}. Type 'help' for a list.`, "#f44");
      return;
    }

    try {
      const result = fn(args, this.world);
      if (result) this.log(result);
    } catch (e: any) {
      this.log(`Error: ${e.message}`, "#f44");
    }
  }

  get isOpen(): boolean {
    return this.visible;
  }

  update(): void {}

  private registerBuiltins(): void {
    this.registerCommand("help", () => {
      const names = Array.from(this.commands.keys()).sort();
      return `Commands: ${names.join(", ")}`;
    });

    this.registerCommand("clear", () => {
      this.output.innerHTML = "";
    });

    this.registerCommand("entities", (_args, world) => {
      return `Total entities: ${world.entityCount}`;
    });

    this.registerCommand("systems", (_args, world) => {
      const systems = world.getSystems();
      const lines = systems.map(s => {
        const name = s.constructor.name;
        const enabled = s.enabled !== false ? "ON" : "OFF";
        return `  ${name} [${s.phase}:${s.priority}] ${enabled}`;
      });
      return `Systems (${systems.length}):\n${lines.join("\n")}`;
    });

    this.registerCommand("enable", (args, world) => {
      const name = args[0];
      if (!name) return "Usage: enable <SystemName>";
      const sys = world.getSystems().find(s => s.constructor.name === name);
      if (!sys) return `System not found: ${name}`;
      sys.enabled = true;
      return `Enabled ${name}`;
    });

    this.registerCommand("disable", (args, world) => {
      const name = args[0];
      if (!name) return "Usage: disable <SystemName>";
      const sys = world.getSystems().find(s => s.constructor.name === name);
      if (!sys) return `System not found: ${name}`;
      sys.enabled = false;
      return `Disabled ${name}`;
    });

    this.registerCommand("stores", (_args, world) => {
      return `Component stores: ${world.storeCount}`;
    });

    this.registerCommand("fps", () => {
      return "Use F3 to toggle the debug overlay for FPS.";
    });

    this.registerCommand("gc", () => {
      if ((globalThis as any).gc) {
        (globalThis as any).gc();
        return "GC triggered.";
      }
      return "GC not available (launch with --expose-gc).";
    });
  }

  private createUI(): void {
    this.container = document.createElement("div");
    this.container.id = "dev-console";
    Object.assign(this.container.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      width: "100%",
      height: "35vh",
      backgroundColor: "rgba(0, 0, 0, 0.92)",
      color: "#ccc",
      fontFamily: "monospace",
      fontSize: "13px",
      zIndex: "100001",
      display: "none",
      flexDirection: "column",
      borderTop: "2px solid #4af",
    });

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "4px 10px",
      color: "#4af",
      fontSize: "12px",
      borderBottom: "1px solid #333",
      flexShrink: "0",
    });
    header.textContent = "AGEE Console — press ` to toggle";

    // Output area
    this.output = document.createElement("div");
    Object.assign(this.output.style, {
      flex: "1",
      overflow: "auto",
      padding: "6px 10px",
      lineHeight: "1.5",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });

    // Input row
    const inputRow = document.createElement("div");
    Object.assign(inputRow.style, {
      display: "flex",
      padding: "4px 10px",
      borderTop: "1px solid #333",
      flexShrink: "0",
    });

    const prompt = document.createElement("span");
    prompt.textContent = "> ";
    prompt.style.color = "#4af";
    prompt.style.lineHeight = "24px";

    this.input = document.createElement("input");
    Object.assign(this.input.style, {
      flex: "1",
      background: "transparent",
      border: "none",
      outline: "none",
      color: "#fff",
      fontFamily: "monospace",
      fontSize: "13px",
      lineHeight: "24px",
    });
    this.input.spellcheck = false;
    this.input.autocomplete = "off";

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.execute(this.input.value);
        this.input.value = "";
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.input.value = this.history[this.historyIndex];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.input.value = this.history[this.historyIndex];
        } else {
          this.historyIndex = this.history.length;
          this.input.value = "";
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        this.autocomplete();
      }
    });

    inputRow.appendChild(prompt);
    inputRow.appendChild(this.input);

    this.container.appendChild(header);
    this.container.appendChild(this.output);
    this.container.appendChild(inputRow);
    document.body.appendChild(this.container);
  }

  private autocomplete(): void {
    const partial = this.input.value.trim();
    if (!partial) return;

    const matches = Array.from(this.commands.keys()).filter(n => n.startsWith(partial));
    if (matches.length === 1) {
      this.input.value = matches[0] + " ";
    } else if (matches.length > 1) {
      this.log(matches.join("  "), "#888");
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "`" || e.key === "~") {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    }
  }

  destroy(): void {
    document.removeEventListener("keydown", this.boundKeyHandler);
    this.container?.remove();
  }
}
