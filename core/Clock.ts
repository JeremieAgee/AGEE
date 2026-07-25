export class Clock {
  private last = 0;
  private _elapsed = 0;
  private _delta = 0;
  private _fps = 0;
  private _frameCount = 0;
  private fpsAccumulator = 0;
  private fpsFrameCount = 0;
  private fpsUpdateInterval = 0.5;
  private _paused = false;
  private _timeScale = 1.0;
  private _rawDelta = 0;

  get delta(): number {
    return this._delta;
  }

  get rawDelta(): number {
    return this._rawDelta;
  }

  get elapsed(): number {
    return this._elapsed;
  }

  get fps(): number {
    return this._fps;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get paused(): boolean {
    return this._paused;
  }

  get timeScale(): number {
    return this._timeScale;
  }

  set timeScale(value: number) {
    this._timeScale = Math.max(0, value);
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  tick(timestamp: number): number {
    const timeS = timestamp / 1000;
    if (this.last === 0) {
      this.last = timeS;
      return 0;
    }

    const rawDelta = timeS - this.last;
    this.last = timeS;

    // Guard against corrupted timestamps
    if (!isFinite(rawDelta) || rawDelta < 0) {
      this._rawDelta = 0;
      this._delta = 0;
      return 0;
    }

    this._rawDelta = Math.min(rawDelta, 0.1);
    this._frameCount++;

    // FPS tracks wall time regardless of pause
    this.fpsFrameCount++;
    this.fpsAccumulator += this._rawDelta;
    if (this.fpsAccumulator >= this.fpsUpdateInterval) {
      this._fps = Math.round(this.fpsFrameCount / this.fpsAccumulator);
      this.fpsFrameCount = 0;
      this.fpsAccumulator = 0;
    }

    if (this._paused) {
      this._delta = 0;
      return 0;
    }

    this._delta = this._rawDelta * this._timeScale;
    this._elapsed += this._delta;

    return this._delta;
  }

  reset(): void {
    this.last = 0;
    this._elapsed = 0;
    this._delta = 0;
    this._rawDelta = 0;
    this._fps = 0;
    this._frameCount = 0;
    this._paused = false;
    this._timeScale = 1.0;
  }
}
