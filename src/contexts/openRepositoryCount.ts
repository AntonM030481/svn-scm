import { Disposable } from "vscode";
import { cancelDebounces, debounce } from "../decorators";
import { SourceControlManager } from "../source_control_manager";
import { IDisposable, setVscodeContext } from "../util";
import { registerResources } from "../lifecycle";

export class OpenRepositoryCount implements IDisposable {
  private disposables: Disposable[] = [];
  readonly initialized: Promise<void>;

  constructor(private sourceControlManager: SourceControlManager) {
    // When repository Opened or closed
    registerResources(
      this.disposables,
      () => sourceControlManager.onDidOpenRepository(this.checkOpened, this),
      () => sourceControlManager.onDidCloseRepository(this.checkOpened, this)
    );

    this.initialized = this.updateContext();
  }

  @debounce(100)
  private checkOpened() {
    void this.updateContext().catch(console.error);
  }

  private updateContext(): Promise<void> {
    return Promise.resolve(
      setVscodeContext(
        "svnOpenRepositoryCount",
        this.sourceControlManager.repositories.length
      )
    );
  }

  public dispose(): void {
    cancelDebounces(this);
    this.disposables.forEach(d => d.dispose());
    void Promise.resolve(setVscodeContext("svnOpenRepositoryCount", 0)).catch(
      console.error
    );
  }
}
