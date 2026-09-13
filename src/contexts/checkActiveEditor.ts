import { Disposable, window } from "vscode";
import { Status } from "../common/types";
import { cancelDebounces, debounce } from "../decorators";
import { SourceControlManager } from "../source_control_manager";
import { IDisposable, setVscodeContext } from "../util";
import { registerResources } from "../lifecycle";

export class CheckActiveEditor implements IDisposable {
  private disposables: Disposable[] = [];
  readonly initialized: Promise<void>;

  constructor(private sourceControlManager: SourceControlManager) {
    // When repository update, like update
    registerResources(
      this.disposables,
      () =>
        sourceControlManager.onDidChangeStatusRepository(
          this.checkHasChangesOnActiveEditor,
          this
        ),
      () =>
        window.onDidChangeActiveTextEditor(
          () => this.checkHasChangesOnActiveEditor(),
          this
        )
    );
    this.initialized = this.updateContext();
  }

  @debounce(100)
  private checkHasChangesOnActiveEditor() {
    void this.updateContext().catch(console.error);
  }

  private updateContext(): Promise<void> {
    return Promise.resolve(
      setVscodeContext(
        "svnActiveEditorHasChanges",
        this.hasChangesOnActiveEditor()
      )
    );
  }

  private hasChangesOnActiveEditor(): boolean {
    if (!window.activeTextEditor) {
      return false;
    }
    const uri = window.activeTextEditor.document.uri;

    const repository = this.sourceControlManager.getRepository(uri);
    if (!repository) {
      return false;
    }

    const resource = repository.getResourceFromFile(uri);
    if (!resource) {
      return false;
    }

    switch (resource.type) {
      case Status.ADDED:
      case Status.DELETED:
      case Status.EXTERNAL:
      case Status.IGNORED:
      case Status.NONE:
      case Status.NORMAL:
      case Status.UNVERSIONED:
        return false;
      case Status.CONFLICTED:
      case Status.INCOMPLETE:
      case Status.MERGED:
      case Status.MISSING:
      case Status.MODIFIED:
      case Status.OBSTRUCTED:
      case Status.REPLACED:
        return true;
    }

    // Show if not match
    return true;
  }

  public dispose(): void {
    cancelDebounces(this);
    this.disposables.forEach(d => d.dispose());
    void Promise.resolve(
      setVscodeContext("svnActiveEditorHasChanges", false)
    ).catch(console.error);
  }
}
