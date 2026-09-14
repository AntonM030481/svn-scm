import * as assert from "assert";
import * as path from "path";
import {
  commands,
  Disposable,
  ExtensionContext,
  ExtensionMode,
  Uri,
  window,
  workspace
} from "vscode";
import type { SourceControlManager as Manager } from "../source_control_manager";
import type { SvnFileSystemProvider as Provider } from "../svnFileSystemProvider";
import { activeExtension } from "./testUtil";

suite("Activation transaction", () => {
  let activate: typeof import("../extension").activate;
  let configuration: typeof import("../helpers/configuration").configuration;
  let SourceControlManager: typeof import("../source_control_manager").SourceControlManager;
  let SvnFinder: typeof import("../svnFinder").SvnFinder;
  const originals = new Map<string, { object: any; value: unknown }>();
  const registrations = new Map<string, (...args: any[]) => any>();
  let resources: Array<{ name: string; disposed: number }>;
  let failure: string | undefined;
  let provider: Provider | undefined;
  let context: ExtensionContext;
  let initialize: (manager: Manager) => Promise<void>;
  const views = new Map<string, any>();
  let configurationListeners: number;
  let editorListeners: number;
  let liveManager: Manager;
  const sentinel = Uri.parse("tempsvnfs:/activation-isolation-sentinel.txt");
  const sentinelBytes = Buffer.from("live activation owns this provider");

  const stub = (object: any, key: string, value: unknown) => {
    originals.set(key, { object, value: object[key] });
    object[key] = value;
  };
  const acquire = (name: string) => {
    if (failure === name) {
      throw new Error(`failure at ${name}`);
    }
    const resource = { name, disposed: 0 };
    resources.push(resource);
    return new Disposable(() => {
      resource.disposed++;
    });
  };
  const disposeContext = () =>
    context.subscriptions
      .splice(0)
      .reverse()
      .forEach(d => d.dispose());

  suiteSetup(async () => {
    // Finish the real host activation before patching shared VS Code APIs.
    await activeExtension();
    liveManager = (await commands.executeCommand(
      "svn.getSourceControlManager"
    ))!;
    await workspace.fs.writeFile(sentinel, sentinelBytes);
    const liveConfiguration = require("../helpers/configuration").configuration;
    const liveTempSvnFs = require("../temp_svn_fs").tempSvnFs;
    const liveManagerClass =
      require("../source_control_manager").SourceControlManager;
    // Fault injection needs separate messages/configuration/temp filesystem
    // singletons. Keep the original cache intact for the live extension and
    // other suites; only this fixture retains the isolated module graph.
    const root = path.resolve(__dirname, "..");
    const owned = (filename: string) => {
      const relative = path.relative(root, filename);
      return (
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        !relative.startsWith(`test${path.sep}`)
      );
    };
    const originalModules = new Map(
      Object.entries(require.cache).filter(([filename]) => owned(filename))
    );
    for (const filename of originalModules.keys()) {
      delete require.cache[filename];
    }
    try {
      ({ activate } = require("../extension"));
      ({ configuration } = require("../helpers/configuration"));
      configuration.dispose();
      ({ SourceControlManager } = require("../source_control_manager"));
      ({ SvnFinder } = require("../svnFinder"));
      assert.notStrictEqual(configuration, liveConfiguration);
      assert.notStrictEqual(require("../temp_svn_fs").tempSvnFs, liveTempSvnFs);
      assert.notStrictEqual(
        SourceControlManager.prototype,
        liveManagerClass.prototype
      );
    } finally {
      for (const filename of Object.keys(require.cache).filter(owned)) {
        delete require.cache[filename];
      }
      for (const [filename, module] of originalModules) {
        require.cache[filename] = module;
      }
    }
  });

  suiteTeardown(async () => {
    configuration?.dispose();
    try {
      assert.strictEqual(
        await commands.executeCommand("svn.getSourceControlManager"),
        liveManager
      );
      assert.ok(
        (await commands.getCommands(true)).includes(
          "svn.forceCommitMessageTest"
        )
      );
      assert.deepStrictEqual(
        Buffer.from(await workspace.fs.readFile(sentinel)),
        sentinelBytes
      );
    } finally {
      await workspace.fs.delete(sentinel);
    }
  });

  setup(() => {
    configuration.dispose();
    resources = [];
    failure = undefined;
    provider = undefined;
    registrations.clear();
    views.clear();
    configurationListeners = 0;
    editorListeners = 0;
    context = {
      subscriptions: [],
      extensionMode: ExtensionMode.Test
    } as unknown as ExtensionContext;
    initialize = async () => {};
    stub(window, "createOutputChannel", () => {
      const disposable = acquire("output");
      return {
        dispose: () => disposable.dispose(),
        append: () => {},
        appendLine: () => {},
        show: () => {}
      };
    });
    stub(
      commands,
      "registerCommand",
      (name: string, handler: (...args: any[]) => any) => {
        const disposable = acquire(name);
        assert.ok(!registrations.has(name), `duplicate command ${name}`);
        registrations.set(name, handler);
        return new Disposable(() => {
          registrations.delete(name);
          disposable.dispose();
        });
      }
    );
    stub(commands, "executeCommand", async (name: string, key?: string) => {
      if (name === "setContext" && failure === key) {
        failure = undefined;
        throw new Error(`failure at ${key}`);
      }
      return undefined;
    });
    stub(window, "registerTreeDataProvider", (name: string, view: unknown) => {
      const resource = acquire(`view:${name}`);
      views.set(name, view);
      return resource;
    });
    stub(window, "onDidChangeActiveTextEditor", () =>
      acquire(`editor:${++editorListeners}`)
    );
    stub(workspace, "onDidChangeConfiguration", () =>
      acquire(`configuration:${++configurationListeners}`)
    );
    stub(workspace, "onDidCloseTextDocument", () => acquire("document-close"));
    stub(
      workspace,
      "registerFileSystemProvider",
      (scheme: string, instance: Provider) => {
        const resource = acquire(`fs:${scheme}`);
        if (scheme === "svn") {
          provider = instance;
        }
        return resource;
      }
    );
    stub(SvnFinder.prototype, "findSvn", async () => {
      if (failure === "find-svn") {
        throw new Error("failure at find-svn");
      }
      return { path: "svn", version: "1.14.0" };
    });
    stub(
      SourceControlManager.prototype,
      "initialize",
      async function (this: Manager) {
        if (failure === "initialize") {
          throw new Error("failure at initialize");
        }
        await initialize(this);
        this.setState("initialized");
      }
    );
  });

  teardown(() => {
    disposeContext();
    for (const [key, { object, value }] of originals) {
      object[key] = value;
    }
    originals.clear();
    configuration.register();
  });

  for (const stage of [
    "configuration:1",
    "output",
    "svn.showOutput",
    "fs:tempsvnfs",
    "document-close",
    "fs:svn",
    "find-svn",
    "configuration:2",
    "svn.getSourceControlManager",
    "svn.searchLogByText",
    "view:svn",
    "svn.treeview.refreshProvider",
    "view:repolog",
    "svn.repolog.openDiff",
    "view:itemlog",
    "svn.itemlog.refresh",
    "view:branchchanges",
    "svn.branchchanges.refresh",
    "editor:2",
    "svnActiveEditorHasChanges",
    "svnOpenRepositoryCount",
    "isSvn18orGreater",
    "isSvn19orGreater",
    "svn.forceCommitMessageTest",
    "initialize"
  ]) {
    test(`failure at ${stage} rejects readiness and releases earlier acquisitions`, async () => {
      failure = stage;
      await assert.rejects(activate(context), /failure at/);
      if (provider) {
        await assert.rejects(
          provider.stat(Uri.parse('svn:/test?{"fsPath":"/test"}')),
          /failure at/
        );
      }
      assert.equal(registrations.size, 0);
      assert.ok(
        resources.every(resource => resource.disposed === 1),
        JSON.stringify(resources.filter(resource => resource.disposed !== 1))
      );
    });
  }

  test("manager command and restored reads wait for complete initialization", async () => {
    let complete!: () => void;
    initialize = () =>
      new Promise(resolve => {
        complete = resolve;
      });
    const activation = activate(context);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(provider);
    let published = false;
    const manager = registrations.get("svn.getSourceControlManager")!().then(
      (result: unknown) => {
        published = true;
        return result;
      }
    );
    await Promise.resolve();
    assert.equal(published, false);
    complete();
    await activation;
    assert.ok(await manager);
    assert.equal(published, true);
  });

  test("repeated activation owns and unregisters the test command", async () => {
    for (let iteration = 0; iteration < 2; iteration++) {
      await activate(context);
      assert.ok(registrations.has("svn.forceCommitMessageTest"));
      disposeContext();
      assert.equal(registrations.size, 0);
    }
    assert.ok(resources.every(resource => resource.disposed === 1));
  });

  for (const failAfterDiscovery of [false, true]) {
    test(`history consumers see discovered repositories; rollback=${failAfterDiscovery}`, async () => {
      let disposed = 0;
      let initializedManager!: Manager;
      const branchRoot = Uri.parse("file:///activation-repository/trunk");
      initialize = async manager => {
        initializedManager = manager;
        manager.openRepositories.push({
          repository: {
            root: "/activation-repository",
            workspaceRoot: "/activation-repository",
            branchRoot,
            repository: { info: { revision: "1" } }
          } as any,
          dispose: () => {
            disposed++;
          }
        });
      };
      if (failAfterDiscovery) {
        failure = "isSvn19orGreater";
        await assert.rejects(activate(context), /failure at/);
        assert.equal(initializedManager.state, "disposed");
        assert.equal(disposed, 1);
      } else {
        await activate(context);
        assert.equal(disposed, 0);
      }
      const repositoryHistory = views.get("repolog");
      const fileHistory = views.get("itemlog");
      if (failAfterDiscovery) {
        assert.equal(repositoryHistory.logCache.size, 0);
      } else {
        assert.ok(repositoryHistory.logCache.has(branchRoot.toString(true)));
      }
      assert.strictEqual(fileHistory.sourceControlManager, initializedManager);
      if (!failAfterDiscovery) {
        assert.equal(fileHistory.sourceControlManager.repositories.length, 1);
      }
    });
  }

  test("production activation does not register the test-only command", async () => {
    (context as any).extensionMode = ExtensionMode.Production;
    await activate(context);
    assert.ok(!registrations.has("svn.forceCommitMessageTest"));
  });

  test("missing SVN recovery retries without registering duplicate bootstrap resources", async () => {
    let attempts = 0;
    SvnFinder.prototype.findSvn = async () => {
      if (++attempts === 1) {
        throw new Error("Svn installation not found");
      }
      return { path: "selected-svn", version: "1.14.0" };
    };
    const get = configuration.get.bind(configuration);
    stub(configuration, "get", (key: string, fallback?: unknown) =>
      key === "ignoreMissingSvnWarning" ? false : get(key, fallback)
    );
    stub(configuration, "update", async () => {});
    stub(window, "showWarningMessage", async () => "Find SVN executable");
    stub(window, "showOpenDialog", async () => [Uri.file("/selected-svn")]);
    await activate(context);
    assert.equal(attempts, 2);
    assert.equal(
      resources.filter(resource => resource.name === "fs:svn").length,
      1
    );
    assert.ok(registrations.has("svn.getSourceControlManager"));
  });

  test("declining missing-SVN recovery leaves restored reads unavailable, not pending", async () => {
    SvnFinder.prototype.findSvn = async () => {
      throw new Error("Svn installation not found");
    };
    const get = configuration.get.bind(configuration);
    stub(configuration, "get", (key: string, fallback?: unknown) =>
      key === "ignoreMissingSvnWarning" ? false : get(key, fallback)
    );
    stub(window, "showWarningMessage", async () => undefined);
    await activate(context);
    await assert.rejects(
      provider!.stat(Uri.parse('svn:/test?{"fsPath":"/test"}')),
      /Svn installation not found/
    );
    assert.ok(!registrations.has("svn.getSourceControlManager"));
    assert.ok(registrations.has("svn.showOutput"));
  });

  test("disposal during executable discovery rejects readiness and prevents late registration", async () => {
    let complete!: (info: { path: string; version: string }) => void;
    SvnFinder.prototype.findSvn = () =>
      new Promise(resolve => {
        complete = resolve;
      });
    const activation = activate(context);
    const acquisitions = resources.length;
    disposeContext();
    await assert.rejects(
      provider!.stat(Uri.parse('svn:/test?{"fsPath":"/test"}')),
      /disposed/
    );
    complete({ path: "late-svn", version: "1.14.0" });
    await assert.rejects(activation, /disposed/);
    assert.equal(resources.length, acquisitions);
    assert.equal(registrations.size, 0);
  });
});
