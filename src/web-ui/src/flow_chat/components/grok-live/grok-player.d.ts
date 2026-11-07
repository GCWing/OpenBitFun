/** Browser ESM port from ArvinYin1/grokbot-animation-anatomy; see SOURCE.txt. */
export interface GrokBot {
    readonly ready: Promise<void>;
    readonly error: unknown;
    readonly state: string;
    readonly el: SVGSVGElement | null;
    setState(state: string): void;
    setFollow(value: boolean): void;
    setGaze(value: [number, number] | null): void;
    setResting(value: boolean): void;
    setGlow(spec: { inner: number[]; mid: number[]; rim: number[]; halo: number } | null): void;
    setExpression(expression: string, options?: { throughBlink?: boolean }): void;
    blink(): void;
    look(direction: string): void;
    poke(kind: string, turns?: number): void;
    destroy(): void;
  }
  export function createGrokBot(container: HTMLElement, opts?: {
    data?: object;
    size?: number;
    maxFps?: number;
    state?: string;
    follow?: boolean;
    reducedMotion?: boolean;
    theme?: { ink: number[]; spot: number[]; cutout: boolean };
    onFrame?: (sample: { intervalMs: number; engineMs: number; domMs: number }) => void;
  }): GrokBot;
