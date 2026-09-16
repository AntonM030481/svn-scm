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

To remove the extension, use **Uninstall** in the Extensions view or run:

```sh
code --uninstall-extension antonm030481.svn-scm-modern
```
