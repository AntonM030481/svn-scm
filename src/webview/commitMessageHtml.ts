export interface CommitMessageWebviewOptions {
  cspSource: string;
  nonce: string;
  styleUri: string;
}

export interface CommitMessageInitialState {
  command: "initialize";
  message: string;
  filePaths: string[];
}

export function createCommitMessageInitialState(
  message?: string,
  filePaths: string[] = []
): CommitMessageInitialState {
  return {
    command: "initialize",
    message: message || "",
    filePaths: [...filePaths].sort()
  };
}

export function getCommitMessageWebviewHtml({
  cspSource,
  nonce,
  styleUri
}: CommitMessageWebviewOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource};">
  <title>Commit Message</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <section class="container">
    <div id="fileList" class="file-list" hidden>
      <h3 class="title">Files to commit</h3>
      <ul id="fileListItems"></ul>
    </div>
    <form>
      <fieldset>
        <div class="float-right">
          <a href="#" id="pickCommitMessage">Pick a previous commit message</a>
        </div>
        <label for="message">Commit message</label>
        <textarea id="message" rows="3" placeholder="Message (press Ctrl+Enter to commit)"></textarea>
        <button id="commit" type="button" class="button-primary">Commit</button>
        <div class="float-right">
          <button id="cancel" type="button" class="button button-outline">Cancel</button>
        </div>
      </fieldset>
    </form>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const fileList = document.getElementById("fileList");
    const fileListItems = document.getElementById("fileListItems");
    const txtMessage = document.getElementById("message");
    const btnCommit = document.getElementById("commit");
    const btnCancel = document.getElementById("cancel");
    const linkPickCommitMessage = document.getElementById("pickCommitMessage");

    function submit() {
      vscode.postMessage({ command: "commit", message: txtMessage.value });
    }

    btnCommit.addEventListener("click", submit);
    btnCancel.addEventListener("click", function() {
      vscode.postMessage({ command: "cancel" });
    });
    txtMessage.addEventListener("keydown", function(e) {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    txtMessage.addEventListener("input", function() {
      txtMessage.style.height = "auto";
      txtMessage.style.height = txtMessage.scrollHeight + "px";
    });
    linkPickCommitMessage.addEventListener("click", function(e) {
      e.preventDefault();
      vscode.postMessage({ command: "pickCommitMessage" });
    });
    window.addEventListener("message", function(event) {
      const data = event.data;
      if (data.command === "initialize") {
        txtMessage.value = data.message || "";
        fileListItems.replaceChildren();
        for (const filePath of data.filePaths) {
          const item = document.createElement("li");
          item.textContent = filePath;
          fileListItems.appendChild(item);
        }
        fileList.hidden = data.filePaths.length === 0;
        txtMessage.dispatchEvent(new Event("input"));
        txtMessage.focus();
      } else if (data.command === "setMessage") {
        txtMessage.value = data.message;
        txtMessage.dispatchEvent(new Event("input"));
      }
    });
    vscode.postMessage({ command: "ready" });
  </script>
</body>
</html>`;
}
