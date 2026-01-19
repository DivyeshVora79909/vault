# Secure Vault Pro 🛡️

A zero-knowledge, client-side secure vault built with a mobile-first approach. Run it entirely in your browser to encrypt, manage, and store files locally.

> **Status:** 🟢 Live at [YOUR_GITHUB_PAGES_LINK_HERE]

## ✨ Features

- **Client-Side Encryption:** Uses the **Web Crypto API (AES-GCM 256-bit)**. Your password and unencrypted files never leave your device.
- **Single File Architecture:** The entire app is a single `.html` file. No database, no backend, no tracking.
- **Mobile First:** Optimized for touch screens with grid layouts and context menus.
- **Format Agnostic:** Stores images, videos, text, code, or any other file type inside a custom `.svault` container.
- **Built-in Tools:**
  - Text Editor (edit `.txt`, `.md`, `.json` inside the vault).
  - Media Viewer (Images & Video).
  - Bulk Upload.

## 🚀 How to Use

1. **Open the App:** Visit the hosted link or open `index.html` locally.
2. **Initialize:** Enter a master password to create a new session.
3. **Manage Files:**
   - Click `+` to upload files or create notes.
   - Click file icons to view them.
   - Use the `⋮` menu to delete or export specific files.
4. **Save:** Click **Save** to download your encrypted `.svault` file.
5. **Resume:** Next time, refresh the page, select your `.svault` file, and enter your password to unlock.

## 🛠️ Tech Stack

- **Tailwind CSS** (Styling)
- **Alpine.js** (State Management)
- **JSZip** (File Bundling)
- **Web Crypto API** (Native Browser Security)

## ⚠️ Security Disclaimer

This software is provided "as is".

1. **There is no "Forgot Password" feature.** If you lose your password, your data is mathematically irretrievable.
2. All encryption happens in **your browser memory**. Closing the tab wipes the unencrypted data from memory.
3. Ensure you keep backups of your `.svault` files.

## 📄 License

MIT License - see [LICENSE](LICENSE) file.
