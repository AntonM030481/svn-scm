import * as path from "path";
import {
  SourceControlResourceGroup,
  SourceControlResourceState,
  Uri,
  window
} from "vscode";
import { checkAndPromptDepth, confirmRevert } from "../input/revert";
import { Resource } from "../resource";
import { Command } from "./command";

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resourceFolderFromScmArgument(
  value: unknown
): { uri: Uri; group: SourceControlResourceGroup } | undefined {
  if (!value || typeof value !== "object") return undefined;

  const uri = (value as { uri?: unknown }).uri;
  const context = (value as { context?: unknown }).context;
  if (!(uri instanceof Uri) || !context || typeof context !== "object") {
    return undefined;
  }

  const group = context as SourceControlResourceGroup;
  if (!Array.isArray(group.resourceStates)) return undefined;
  return { uri, group };
}

export class Revert extends Command {
  constructor() {
    super("svn.revert");
  }

  public async execute(...resourceStates: SourceControlResourceState[]) {
    const expanded: SourceControlResourceState[] = [];

    for (const resourceState of resourceStates as unknown[]) {
      const folder = resourceFolderFromScmArgument(resourceState);
      if (!folder) {
        expanded.push(resourceState as SourceControlResourceState);
        continue;
      }

      for (const candidate of folder.group.resourceStates) {
        if (isPathInside(folder.uri.fsPath, candidate.resourceUri.fsPath)) {
          expanded.push(candidate);
        }
      }
    }

    const selection = await this.getResourceStates(expanded, true);

    if (selection.length === 0 || !(await confirmRevert())) {
      return;
    }

    const uris = selection.map(resource => resource.resourceUri);
    const depth = await checkAndPromptDepth(uris);

    if (!depth) {
      return;
    }

    await this.runByRepository(uris, async (repository, resources) => {
      if (!repository) {
        return;
      }

      const paths = resources.map(resource => resource.fsPath).reverse();

      try {
        await repository.revert(paths, depth);
      } catch (error) {
        console.log(error);
        window.showErrorMessage("Unable to revert");
      }
    });
  }
}
