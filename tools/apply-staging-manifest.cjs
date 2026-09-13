const fs = require("node:fs");
let s = fs.readFileSync("package.json", "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const t = x => x.replace(/\n/g, nl);
function replaceOnce(oldText, newText) {
  const oldValue = t(oldText);
  if (!s.includes(oldValue)) throw new Error(`anchor not found: ${oldText.slice(0, 60)}`);
  s = s.replace(oldValue, t(newText));
}

const commandAnchor = `            {
                "command": "svn.commitWithMessage",
                "title": "Commit Changes",
                "category": "SVN",
                "icon": "$(check)"
            },
`;
replaceOnce(commandAnchor, commandAnchor + `            {
                "command": "svn.commitStaged",
                "title": "Commit Staged",
                "category": "SVN",
                "icon": "$(check)"
            },
            {
                "command": "svn.commitAll",
                "title": "Commit All Changes",
                "category": "SVN",
                "icon": "$(check-all)"
            },
            {
                "command": "svn.stage",
                "title": "Stage Changes",
                "category": "SVN",
                "icon": "$(add)"
            },
            {
                "command": "svn.unstage",
                "title": "Unstage Changes",
                "category": "SVN",
                "icon": "$(remove)"
            },
            {
                "command": "svn.stageAll",
                "title": "Stage All Changes",
                "category": "SVN",
                "icon": "$(add)"
            },
            {
                "command": "svn.unstageAll",
                "title": "Unstage All Changes",
                "category": "SVN",
                "icon": "$(remove)"
            },
`);

const paletteAnchor = `                {
                    "command": "svn.commitWithMessage",
                    "when": "false"
                },
`;
replaceOnce(paletteAnchor, paletteAnchor + `                {
                    "command": "svn.commitStaged",
                    "when": "config.svn.enabled && svnOpenRepositoryCount != 0"
                },
                {
                    "command": "svn.commitAll",
                    "when": "config.svn.enabled && svnOpenRepositoryCount != 0"
                },
                {
                    "command": "svn.stage",
                    "when": "false"
                },
                {
                    "command": "svn.unstage",
                    "when": "false"
                },
                {
                    "command": "svn.stageAll",
                    "when": "config.svn.enabled && svnOpenRepositoryCount != 0"
                },
                {
                    "command": "svn.unstageAll",
                    "when": "config.svn.enabled && svnOpenRepositoryCount != 0"
                },
`);

replaceOnce(`                {
                    "command": "svn.commitWithMessage",
                    "group": "navigation",
                    "when": "config.svn.enabled && scmProvider == svn"
                },
`, `                {
                    "command": "svn.commitStaged",
                    "group": "navigation",
                    "when": "config.svn.enabled && scmProvider == svn"
                },
                {
                    "command": "svn.commitAll",
                    "when": "config.svn.enabled && scmProvider == svn"
                },
`);

const groupAnchor = `                {
                    "command": "svn.revertAll",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup == changes",
                    "group": "navigation"
                },
`;
replaceOnce(groupAnchor, `                {
                    "command": "svn.stageAll",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup != staged && scmResourceGroup != conflicts && scmResourceGroup != remotechanges && scmResourceGroup != external",
                    "group": "inline"
                },
                {
                    "command": "svn.unstageAll",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup == staged",
                    "group": "inline"
                },
` + groupAnchor);

replaceOnce(`                {
                    "command": "svn.add",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup == unversioned",
                    "group": "inline"
                },
`, `                {
                    "command": "svn.stage",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup != staged && scmResourceGroup != conflicts && scmResourceGroup != remotechanges && scmResourceGroup != external",
                    "group": "inline"
                },
                {
                    "command": "svn.unstage",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup == staged",
                    "group": "inline"
                },
`);

replaceOnce(`                {
                    "command": "svn.changelist",
                    "when": "config.svn.enabled && scmProvider == svn && scmResourceGroup != unversioned && scmResourceGroup != external && scmResourceGroup != conflicts && scmResourceGroup != remotechanges",
                    "group": "inline"
                },
`, "");

fs.writeFileSync("package.json", s, "utf8");
