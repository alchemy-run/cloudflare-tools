import type { WorkflowBinding } from "@distilled.cloud/vendor-workflows-shared/workers/workflows-shared/src/binding";

const dispose = (value: unknown) => {
  const d = (value as { [Symbol.dispose]?: () => void })[Symbol.dispose];
  if (typeof d === "function") {
    d.call(value);
  }
};

class WorkflowImpl implements Workflow {
  constructor(private binding: WorkflowBinding) {}

  async get(id: string): Promise<WorkflowInstance> {
    const instanceHandle = new InstanceImpl(id, this.binding);
    await instanceHandle.status();
    return instanceHandle;
  }

  async create(options?: WorkflowInstanceCreateOptions): Promise<WorkflowInstance> {
    const result = (await this.binding.create(options)) as WorkflowInstance & Disposable;
    try {
      return new InstanceImpl(result.id, this.binding);
    } finally {
      dispose(result);
    }
  }

  async createBatch(options: WorkflowInstanceCreateOptions[]): Promise<WorkflowInstance[]> {
    const result = await this.binding.createBatch(options);
    return result.map((res) => new InstanceImpl(res.id, this.binding));
  }

  async unsafeGetBindingName(): Promise<string> {
    return this.binding.unsafeGetBindingName();
  }

  async unsafeAbort(instanceId: string, reason?: string): Promise<void> {
    return this.binding.unsafeAbort(instanceId, reason);
  }

  async unsafeGetInstanceModifier(instanceId: string): Promise<unknown> {
    return this.binding.unsafeGetInstanceModifier(instanceId);
  }

  async unsafeWaitForStepResult(
    instanceId: string,
    name: string,
    index?: number,
  ): Promise<unknown> {
    return this.binding.unsafeWaitForStepResult(instanceId, name, index);
  }

  async unsafeWaitForStatus(instanceId: string, status: string): Promise<void> {
    return await this.binding.unsafeWaitForStatus(instanceId, status);
  }

  public async unsafeGetOutputOrError(instanceId: string, isOutput: boolean): Promise<unknown> {
    return this.binding.unsafeGetOutputOrError(instanceId, isOutput);
  }
}

class InstanceImpl implements WorkflowInstance {
  constructor(
    public id: string,
    private binding: WorkflowBinding,
  ) {}

  private async getInstance(): Promise<WorkflowInstance & Disposable> {
    return (await this.binding.get(this.id)) as WorkflowInstance & Disposable;
  }

  public async pause(): Promise<void> {
    const instance = await this.getInstance();
    try {
      await instance.pause();
    } finally {
      dispose(instance);
    }
  }

  public async resume(): Promise<void> {
    const instance = await this.getInstance();
    try {
      await instance.resume();
    } finally {
      dispose(instance);
    }
  }

  public async terminate(): Promise<void> {
    const instance = await this.getInstance();
    try {
      await instance.terminate();
    } finally {
      dispose(instance);
    }
  }

  public async restart(): Promise<void> {
    const instance = await this.getInstance();
    try {
      await instance.restart();
    } finally {
      dispose(instance);
    }
  }

  public async status(): Promise<InstanceStatus> {
    const instance = await this.getInstance();
    try {
      const res = (await instance.status()) as InstanceStatus & Disposable;
      try {
        return structuredClone(res);
      } finally {
        dispose(res);
      }
    } finally {
      dispose(instance);
    }
  }

  public async sendEvent(args: { payload: unknown; type: string }): Promise<void> {
    const instance = await this.getInstance();
    try {
      await instance.sendEvent(args);
    } finally {
      dispose(instance);
    }
  }
}

export function makeBinding(env: { binding: WorkflowBinding }): Workflow {
  return new WorkflowImpl(env.binding);
}

export default makeBinding;
