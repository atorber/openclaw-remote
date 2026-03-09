# 将 openclaw-remote 独立为 GitHub 仓库

本文说明如何把当前目录拆成独立仓库 `openclaw-remote`，并**保留**主仓库 openclaw 不变。

## 1. 仓库地址

独立仓库：**https://github.com/atorber/openclaw-remote.git**

（若尚未创建，在 GitHub 上新建空仓库 `atorber/openclaw-remote`，不要勾选 README/.gitignore。）

## 2. 导出并推送到新仓库（在本地执行）

在**主仓库 openclaw 的根目录**执行：

```bash
# 进入主仓库
cd /path/to/openclaw

# 用 rsync 复制 openclaw-remote，排除构建产物和依赖（不修改原目录）
rsync -a --exclude='node_modules' --exclude='openclaw-remote/ui-mqtt/src-tauri/target' \
  --exclude='openclaw-remote/ui-mqtt/dist' --exclude='.knowledge' \
  openclaw-remote/ /tmp/openclaw-remote-export/

# 初始化新仓库并推送
cd /tmp/openclaw-remote-export
git init
git add .
git commit -m "chore: initial standalone openclaw-remote repo"
git branch -M main
git remote add origin https://github.com/atorber/openclaw-remote.git
git push -u origin main
```

若使用 SSH：

```bash
git remote add origin git@github.com:atorber/openclaw-remote.git
git push -u origin main
```

## 3. 主仓库 openclaw 的后续处理（二选一）

- **方案 A（推荐）**：从主仓库中删除 `openclaw-remote` 目录并提交，以后只在独立仓库中维护。
- **方案 B**：在主仓库中把 `openclaw-remote` 改为 submodule，指向新仓库，便于在主仓库中一并 clone：
  ```bash
  cd /path/to/openclaw
  git rm -r --cached openclaw-remote  # 若曾被跟踪
  git submodule add https://github.com/atorber/openclaw-remote.git openclaw-remote
  git add .gitmodules openclaw-remote
  git commit -m "chore: move openclaw-remote to standalone repo as submodule"
  ```

完成以上步骤后，`openclaw-remote` 即为独立 GitHub 仓库，主仓库可根据需要保留或改为 submodule。
