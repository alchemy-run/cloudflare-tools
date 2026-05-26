export interface WorkflowEntry {
  readonly name: string;
  readonly className: string;
  readonly scriptName?: string;
  readonly stepLimit?: number;
  readonly compatibilityFlags?: ReadonlyArray<string>;
}
