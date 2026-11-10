# libvterm（vendored）

- 上游：https://github.com/neovim/libvterm（Neovim 镜像，上游为 git.leonerd.org.uk 的 libvterm）
- 固定提交：`934bc2fbf21800ac3458a499df8820ca5fb45fd3`（分支 `nvim`）
- 许可证：MIT（见同目录 `LICENSE`）
- 只取 `include/` 与 `src/`（不含 `bin/`、`doc/`、`t/`、构建脚本）；`src/encoding/*.inc` 与 `src/fullwidth.inc` 是仓库内已生成的表，随源一起。
- 修改：无（原样 vendored）。升级时整目录替换并更新本文件与 `LICENSES/libvterm.txt`。
