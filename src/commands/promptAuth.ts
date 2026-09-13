import { CancellationToken, window } from "vscode";
import { IAuth } from "../common/types";
import { Command } from "./command";

export class PromptAuth extends Command {
  constructor() {
    super("svn.promptAuth");
  }

  public async execute(
    prevUsername?: string,
    prevPassword?: string,
    token?: CancellationToken
  ) {
    if (token?.isCancellationRequested) {
      return;
    }
    const username = await window.showInputBox(
      {
        placeHolder: "Svn repository username",
        prompt: "Please enter your username",
        ignoreFocusOut: true,
        value: prevUsername
      },
      token
    );

    if (username === undefined || token?.isCancellationRequested) {
      return;
    }

    const password = await window.showInputBox(
      {
        placeHolder: "Svn repository password",
        prompt: "Please enter your password",
        value: prevPassword,
        ignoreFocusOut: true,
        password: true
      },
      token
    );

    if (password === undefined || token?.isCancellationRequested) {
      return;
    }

    const auth: IAuth = {
      username,
      password
    };

    return auth;
  }
}
