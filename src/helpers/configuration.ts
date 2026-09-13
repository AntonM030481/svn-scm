"use strict";

import {
  ConfigurationChangeEvent,
  ConfigurationTarget,
  Disposable,
  Event,
  EventEmitter,
  workspace,
  WorkspaceConfiguration
} from "vscode";

const SVN = "svn";

class Configuration implements Disposable {
  private configuration: WorkspaceConfiguration;
  private _onDidChange = new EventEmitter<ConfigurationChangeEvent>();
  private configurationChangeDisposable?: Disposable;

  get onDidChange(): Event<ConfigurationChangeEvent> {
    return this._onDidChange.event;
  }

  constructor() {
    this.configuration = workspace.getConfiguration(SVN);
    this.register();
  }

  public register(): void {
    if (this.configurationChangeDisposable) {
      return;
    }
    this.configuration = workspace.getConfiguration(SVN);
    this.configurationChangeDisposable = workspace.onDidChangeConfiguration(
      this.onConfigurationChanged,
      this
    );
  }

  private onConfigurationChanged(event: ConfigurationChangeEvent) {
    if (!event.affectsConfiguration(SVN)) {
      return;
    }

    this.configuration = workspace.getConfiguration(SVN);

    this._onDidChange.fire(event);
  }

  public get<T>(section: string, defaultValue?: T): T {
    return this.configuration.get<T>(section, defaultValue!);
  }

  public update(
    section: string,
    value: any,
    configurationTarget?: ConfigurationTarget | boolean
  ): Thenable<void> {
    return this.configuration.update(section, value, configurationTarget);
  }

  public inspect(section: string) {
    return this.configuration.inspect(section);
  }

  public dispose(): void {
    this.configurationChangeDisposable?.dispose();
    this.configurationChangeDisposable = undefined;
    this._onDidChange.dispose();
    this._onDidChange = new EventEmitter<ConfigurationChangeEvent>();
  }
}

export const configuration = new Configuration();
