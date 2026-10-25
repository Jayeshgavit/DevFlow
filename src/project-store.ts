import type { Project } from './types';

export type ProjectLoadStatus = 'loading' | 'ready' | 'failed';
export type ProjectSnapshot = { status: ProjectLoadStatus; projects: Project[]; dirty: boolean; loadError: string };

export class ProjectStore {
  private snapshot: ProjectSnapshot = { status: 'loading', projects: [], dirty: false, loadError: '' };
  private revision = 0;
  private pendingSave: Promise<void> = Promise.resolve();
  private pendingLoad: Promise<Project[]> | null = null;

  constructor(
    private readonly read: () => Promise<Project[]>,
    private readonly write: (projects: Project[]) => Promise<void>,
    private readonly onChange: (snapshot: ProjectSnapshot) => void,
  ) {}

  get current(): ProjectSnapshot { return this.snapshot; }

  load(): Promise<Project[]> {
    if (this.snapshot.status === 'ready') return Promise.resolve(this.snapshot.projects);
    if (this.pendingLoad) return this.pendingLoad;
    this.publish({ ...this.snapshot, status: 'loading', loadError: '' });
    const attempt = (async () => {
      // A retry must observe any write that was already in flight before reading.
      await this.pendingSave;
      try {
        const projects = await this.read();
        this.revision += 1;
        this.publish({ status: 'ready', projects, dirty: false, loadError: '' });
        return projects;
      } catch (cause) {
        this.publish({ ...this.snapshot, status: 'failed', loadError: String(cause) });
        throw cause;
      }
    })();
    this.pendingLoad = attempt;
    void attempt.then(() => { if (this.pendingLoad === attempt) this.pendingLoad = null; }, () => { if (this.pendingLoad === attempt) this.pendingLoad = null; });
    return attempt;
  }

  edit(update: (projects: Project[]) => Project[]): void {
    this.requireReady();
    this.revision += 1;
    this.publish({ ...this.snapshot, projects: update(this.snapshot.projects), dirty: true });
  }

  save(): Promise<void> {
    this.requireReady();
    return this.enqueue(async () => {
      this.requireReady();
      const projects = this.snapshot.projects;
      const revision = this.revision;
      await this.write(projects);
      if (this.revision === revision) this.publish({ ...this.snapshot, dirty: false });
    });
  }

  updateAndSave(update: (projects: Project[]) => Project[]): Promise<void> {
    this.requireReady();
    return this.enqueue(async () => {
      this.requireReady();
      const revision = this.revision;
      const next = update(this.snapshot.projects);
      await this.write(next);
      if (this.revision === revision) {
        this.revision += 1;
        this.publish({ ...this.snapshot, projects: next, dirty: false });
      } else {
        // Keep edits made during the write; they have not reached disk yet.
        this.revision += 1;
        this.publish({ ...this.snapshot, projects: update(this.snapshot.projects), dirty: true });
      }
    });
  }

  private requireReady(): void {
    if (this.snapshot.status !== 'ready') throw new Error('Projects could not be loaded. Retry Load before changing saved projects.');
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.pendingSave.then(work, work);
    this.pendingSave = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private publish(snapshot: ProjectSnapshot): void {
    this.snapshot = snapshot;
    this.onChange(snapshot);
  }
}
