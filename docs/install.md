# Installing from a VSIX

Use a VSIX package for manual or offline installation when Marketplace access
is unavailable.

1. Open the latest [GitHub Release](https://github.com/AntonM030481/svn-scm/releases/latest).
2. Download the `svn-scm-v<version>.vsix` asset.
3. In VS Code, open **Extensions**, select **Views and More Actions** (`...`),
   choose **Install from VSIX...**, and select the downloaded file.
4. Reload VS Code when prompted.

You can also install the package from a terminal:

```sh
code --install-extension path/to/svn-scm-v<version>.vsix --force
```

VSIX installations do not update automatically through Marketplace. Repeat the
steps with a newer release to update manually.

## Migrating from 2.24 and earlier

The Marketplace remediation changes the extension identifier from
`antonm030481.svn-scm-modern` to
`antonm030481.subversion-workbench`. VS Code treats those as separate
extensions, so uninstall the old extension before installing Subversion
Workbench to avoid duplicate SCM providers.

The existing `svn.*` settings and commands are intentionally unchanged, so no
settings migration is required.

To remove the extension, use **Uninstall** in the Extensions view or run:

```sh
code --uninstall-extension antonm030481.subversion-workbench
```
