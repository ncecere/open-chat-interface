export interface ModelLab {
  /** Stable slug persisted on the model row. */
  id: string;
  name: string;
  /** Paths relative to the `/logos` static prefix. */
  light: string;
  dark: string;
}
