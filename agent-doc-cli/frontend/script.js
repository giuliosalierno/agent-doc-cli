document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const chatMessages = document.getElementById('chat-messages');
    const fileTabs = document.getElementById('file-tabs');
    const editorEmpty = document.getElementById('editor-empty');
    const editorDocument = document.getElementById('editor-document');
    const lineNumbers = document.getElementById('line-numbers');
    const documentBody = document.getElementById('document-body');
    const refreshBtn = document.getElementById('refresh-btn');
    const panelEditor = document.getElementById('panel-editor');
    const resizeHandle = document.getElementById('resize-handle');
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');

    // State
    let currentFile = null;
    let currentContent = '';
    let workspaceFiles = [];
    let isSending = false;

    // ---- Marked config ----
    marked.setOptions({
        breaks: true,
        gfm: true,
    });

    // ---- Workspace API ----
    async function loadWorkspace() {
        try {
            const res = await fetch('/api/workspace');
            const data = await res.json();
            workspaceFiles = data.files || [];
            renderFileTabs();
        } catch (e) {
            console.error('Failed to load workspace:', e);
        }
    }

    async function loadFile(filename) {
        try {
            const res = await fetch(`/api/workspace/${encodeURIComponent(filename)}`);
            const data = await res.json();
            if (data.error) {
                console.error('File load error:', data.error);
                return;
            }
            currentFile = filename;
            currentContent = data.content;
            renderDocument(currentContent);
            renderFileTabs();
        } catch (e) {
            console.error('Failed to load file:', e);
        }
    }

    // ---- File Tabs ----
    function renderFileTabs() {
        fileTabs.innerHTML = '';

        if (workspaceFiles.length === 0 && !currentFile) {
            const tab = document.createElement('div');
            tab.className = 'file-tab empty-tab active';
            tab.innerHTML = '<span class="tab-icon">&#9671;</span><span>no file</span>';
            fileTabs.appendChild(tab);
            return;
        }

        workspaceFiles.forEach(file => {
            const tab = document.createElement('div');
            tab.className = 'file-tab' + (file.name === currentFile ? ' active' : '');

            const icon = document.createElement('span');
            icon.className = 'tab-icon';
            icon.textContent = fileIcon(file.name);

            const name = document.createElement('span');
            name.textContent = file.name;

            const close = document.createElement('span');
            close.className = 'tab-close';
            close.textContent = '×';
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                closeTab(file.name);
            });

            tab.appendChild(icon);
            tab.appendChild(name);
            tab.appendChild(close);

            tab.addEventListener('click', () => loadFile(file.name));
            fileTabs.appendChild(tab);
        });
    }

    function fileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const icons = { md: '◇', txt: '◆', html: '◈', pdf: '◉', docx: '◎' };
        return icons[ext] || '◇';
    }

    function closeTab(filename) {
        if (currentFile === filename) {
            // Switch to another file or show empty state
            const remaining = workspaceFiles.filter(f => f.name !== filename);
            if (remaining.length > 0) {
                loadFile(remaining[0].name);
            } else {
                currentFile = null;
                currentContent = '';
                editorDocument.style.display = 'none';
                editorEmpty.style.display = 'flex';
                renderFileTabs();
            }
        }
        // Remove from workspace files list (tab only, doesn't delete the file)
        workspaceFiles = workspaceFiles.filter(f => f.name !== filename);
        renderFileTabs();
    }

    // ---- Document Rendering ----
    const editorContent = document.getElementById('editor-content');

    function renderDocument(content, changedLines) {
        editorEmpty.style.display = 'none';
        editorDocument.style.display = 'flex';

        const lines = content.split('\n');
        const isMarkdown = currentFile && currentFile.endsWith('.md');
        const hasChanges = changedLines && changedLines.size > 0;

        // Line numbers
        lineNumbers.innerHTML = '';
        lines.forEach((_, i) => {
            const ln = document.createElement('div');
            ln.className = 'line-number';
            if (hasChanges && changedLines.has(i + 1)) {
                ln.classList.add('highlighted');
            }
            ln.textContent = i + 1;
            lineNumbers.appendChild(ln);
        });

        // Document body
        if (isMarkdown) {
            documentBody.innerHTML = marked.parse(content);
        } else {
            documentBody.innerHTML = '';
            lines.forEach((line) => {
                const div = document.createElement('div');
                div.className = 'doc-line';
                div.textContent = line || '\u200B';
                documentBody.appendChild(div);
            });
        }
    }

    // Build an inline diff view: context lines, removed lines (red), added lines (green)
    function parseDiffToLines(diffText) {
        const result = []; // { type: 'ctx'|'add'|'del', text: string }
        const diffLines = diffText.split('\n');
        let inHunk = false;

        for (const line of diffLines) {
            if (line.startsWith('@@')) {
                inHunk = true;
                continue;
            }
            if (!inHunk) continue;
            if (line.startsWith('---') || line.startsWith('+++')) continue;

            if (line.startsWith('+')) {
                result.push({ type: 'add', text: line.slice(1) });
            } else if (line.startsWith('-')) {
                result.push({ type: 'del', text: line.slice(1) });
            } else {
                result.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
            }
        }
        return result;
    }

    // Render the document with inline diff overlaid, then transition to final content
    function renderWithInlineDiff(newContent, diffText) {
        editorEmpty.style.display = 'none';
        editorDocument.style.display = 'flex';

        const diffLines = parseDiffToLines(diffText);

        // If diff parsing failed, fall back to simple render
        if (diffLines.length === 0) {
            renderDocument(newContent);
            return;
        }

        // Build full file view: merge unchanged (from new content) with diff hunks
        // Strategy: reconstruct the file using diff hunks spliced into context
        const newLines = newContent.split('\n');

        // Parse hunk positions from the diff to know where they apply
        const hunks = [];
        const rawDiffLines = diffText.split('\n');
        let currentHunk = null;

        for (const line of rawDiffLines) {
            const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (hunkMatch) {
                if (currentHunk) hunks.push(currentHunk);
                currentHunk = {
                    newStart: parseInt(hunkMatch[3], 10),
                    lines: [],
                };
                continue;
            }
            if (!currentHunk) continue;
            if (line.startsWith('---') || line.startsWith('+++')) continue;

            if (line.startsWith('+')) {
                currentHunk.lines.push({ type: 'add', text: line.slice(1) });
            } else if (line.startsWith('-')) {
                currentHunk.lines.push({ type: 'del', text: line.slice(1) });
            } else {
                currentHunk.lines.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
            }
        }
        if (currentHunk) hunks.push(currentHunk);

        // Build display lines: for each line in the new file, check if it's part of a hunk
        // We interleave deleted lines right before their replacement
        const displayLines = []; // { type, text, lineNum (in new file, null for del) }
        const hunkMap = new Map(); // newLineNum -> hunk

        for (const hunk of hunks) {
            hunkMap.set(hunk.newStart, hunk);
        }

        let newIdx = 0; // 0-based index into newLines
        const processedHunkStarts = new Set();

        while (newIdx < newLines.length) {
            const newLineNum = newIdx + 1;

            // Check if a hunk starts at this new line number
            if (hunkMap.has(newLineNum) && !processedHunkStarts.has(newLineNum)) {
                processedHunkStarts.add(newLineNum);
                const hunk = hunkMap.get(newLineNum);

                // Walk through hunk lines
                let hunkNewIdx = newIdx;
                for (const hl of hunk.lines) {
                    if (hl.type === 'del') {
                        displayLines.push({ type: 'del', text: hl.text, lineNum: null });
                    } else if (hl.type === 'add') {
                        displayLines.push({ type: 'add', text: hl.text, lineNum: hunkNewIdx + 1 });
                        hunkNewIdx++;
                    } else {
                        displayLines.push({ type: 'ctx', text: hl.text, lineNum: hunkNewIdx + 1 });
                        hunkNewIdx++;
                    }
                }
                newIdx = hunkNewIdx;
            } else {
                displayLines.push({ type: 'ctx', text: newLines[newIdx], lineNum: newLineNum });
                newIdx++;
            }
        }

        // Render line numbers
        lineNumbers.innerHTML = '';
        for (const dl of displayLines) {
            const ln = document.createElement('div');
            ln.className = 'line-number';
            if (dl.type === 'del') {
                ln.classList.add('ln-del');
                ln.textContent = '−';
            } else if (dl.type === 'add') {
                ln.classList.add('highlighted');
                ln.textContent = dl.lineNum;
            } else {
                ln.textContent = dl.lineNum;
            }
            lineNumbers.appendChild(ln);
        }

        // Render document body with diff styling
        documentBody.innerHTML = '';
        let firstChangedEl = null;

        for (const dl of displayLines) {
            const div = document.createElement('div');
            div.className = 'doc-line';
            div.textContent = dl.text || '\u200B';

            if (dl.type === 'del') {
                div.classList.add('diff-line-del');
                if (!firstChangedEl) firstChangedEl = div;
            } else if (dl.type === 'add') {
                div.classList.add('diff-line-add');
                if (!firstChangedEl) firstChangedEl = div;
            }

            documentBody.appendChild(div);
        }

        // Scroll to first change
        if (firstChangedEl) {
            setTimeout(() => {
                firstChangedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }

        // After 4 seconds, transition to the clean final document
        setTimeout(() => {
            currentContent = newContent;
            renderDocument(newContent);
        }, 4000);
    }

    function scrollEditorToLine(lineNum, totalLines) {
        // Scroll the editor content area so the changed line is visible
        const lineHeight = 20.8;
        const scrollTarget = (lineNum - 1) * lineHeight;
        const viewportHeight = editorContent.clientHeight;
        // Center the line in the viewport
        const scrollTo = Math.max(0, scrollTarget - viewportHeight / 3);

        editorContent.scrollTo({
            top: scrollTo,
            behavior: 'smooth',
        });
    }

    // ---- Diff Parsing ----
    function parseChangedLines(diffText) {
        const changed = new Set();
        const lines = diffText.split('\n');
        let newLineNum = 0;

        for (const line of lines) {
            const hunkMatch = line.match(/^@@ .+\+(\d+)/);
            if (hunkMatch) {
                newLineNum = parseInt(hunkMatch[1], 10);
                continue;
            }
            if (line.startsWith('+') && !line.startsWith('+++')) {
                changed.add(newLineNum);
                newLineNum++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                // deleted line, don't increment new line counter
            } else {
                newLineNum++;
            }
        }
        return changed;
    }

    // ---- Chat ----
    function appendMessage(role, content) {
        const el = document.createElement('div');
        el.className = `message message-${role}`;
        if (role === 'agent') {
            el.setAttribute('data-raw', content);
            el.innerHTML = marked.parse(content);
        } else {
            el.textContent = content;
        }
        chatMessages.appendChild(el);
        scrollChat();
        return el;
    }

    function appendToolBadge(type, name, detail) {
        const badge = document.createElement('div');
        badge.className = `tool-badge tool-badge-${type}`;

        if (type === 'call') {
            const spinner = document.createElement('div');
            spinner.className = 'tool-spinner';
            badge.appendChild(spinner);

            const text = document.createElement('span');
            text.textContent = name;
            badge.appendChild(text);

            if (detail) {
                const args = document.createElement('span');
                args.className = 'tool-icon';
                // Show first arg value as hint
                const firstVal = Object.values(detail)[0];
                if (typeof firstVal === 'string' && firstVal.length < 30) {
                    args.textContent = ` → ${firstVal}`;
                }
                badge.appendChild(args);
            }
        } else {
            const icon = document.createElement('span');
            icon.className = 'tool-icon';
            icon.textContent = '✓';
            badge.appendChild(icon);

            const text = document.createElement('span');
            text.textContent = name;
            badge.appendChild(text);

            badge.classList.add('success');
        }

        chatMessages.appendChild(badge);
        scrollChat();
        return badge;
    }

    function renderDiff(diffText) {
        if (!diffText || !diffText.includes('@@')) return null;

        const container = document.createElement('div');
        container.className = 'diff-container';

        try {
            const diffHtml = Diff2Html.html(diffText, {
                drawFileList: false,
                matching: 'lines',
                outputFormat: 'line-by-line',
            });
            container.innerHTML = diffHtml;
        } catch (e) {
            // Fallback: show raw diff
            const pre = document.createElement('pre');
            pre.style.cssText = 'font-size:11px;padding:8px;color:var(--text-secondary)';
            pre.textContent = diffText;
            container.appendChild(pre);
        }

        // Show expanded by default, toggle to collapse
        const toggle = document.createElement('button');
        toggle.className = 'diff-toggle';
        toggle.textContent = '▾ hide diff';
        toggle.addEventListener('click', () => {
            const showing = container.style.display !== 'none';
            container.style.display = showing ? 'none' : 'block';
            toggle.textContent = showing ? '▸ show diff' : '▾ hide diff';
        });

        const wrapper = document.createElement('div');
        wrapper.appendChild(toggle);
        wrapper.appendChild(container);
        chatMessages.appendChild(wrapper);
        scrollChat();
        return wrapper;
    }

    function showTyping() {
        const el = document.createElement('div');
        el.className = 'typing-indicator';
        el.id = 'typing-indicator';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.className = 'typing-dot';
            el.appendChild(dot);
        }
        chatMessages.appendChild(el);
        scrollChat();
    }

    function hideTyping() {
        const el = document.getElementById('typing-indicator');
        if (el) el.remove();
    }

    function scrollChat() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function setStatus(text, color) {
        statusText.textContent = text;
        statusDot.style.background = color || 'var(--success)';
        statusDot.style.boxShadow = `0 0 6px ${color || 'rgba(52,211,153,0.4)'}`;
    }

    // ---- Send Message ----
    async function sendMessage() {
        const message = userInput.value.trim();
        if (!message || isSending) return;

        isSending = true;
        sendBtn.disabled = true;
        userInput.value = '';

        appendMessage('user', message);
        showTyping();
        setStatus('thinking', 'var(--accent)');

        // Track last tool call name for matching with results
        let lastToolCallName = null;
        let agentMessageEl = null;
        let firstChunk = true;
        let lastDiffText = null;

        try {
            const response = await fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            });

            if (!response.body) {
                hideTyping();
                setStatus('error', 'var(--error)');
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                if (firstChunk) {
                    hideTyping();
                    firstChunk = false;
                }

                buffer += decoder.decode(value, { stream: true });

                let boundary = buffer.indexOf('\n');
                while (boundary !== -1) {
                    const line = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 1);

                    if (line.trim()) {
                        try {
                            const data = JSON.parse(line);
                            handleStreamEvent(data);
                        } catch (e) {
                            console.error('Parse error:', e, line);
                        }
                    }
                    boundary = buffer.indexOf('\n');
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                try {
                    const data = JSON.parse(buffer);
                    handleStreamEvent(data);
                } catch (e) { /* ignore */ }
            }

            function handleStreamEvent(data) {
                console.log('[DocAI stream]', data.type, data.name || '', data);

                if (data.type === 'tool_call') {
                    lastToolCallName = data.name;
                    setStatus(`running ${data.name}`, 'var(--accent)');
                    appendToolBadge('call', data.name, data.args);

                } else if (data.type === 'tool_result') {
                    appendToolBadge('result', data.name);

                    // Check for unified diff in any file-modifying tool result
                    if (data.result && data.result.includes('@@') && data.result.includes('---')) {
                        lastDiffText = data.result;
                        renderDiff(data.result);
                    }

                } else if (data.type === 'workspace_changed') {
                    // Refresh workspace and reload current file
                    const diffForRender = lastDiffText;
                    lastDiffText = null;

                    loadWorkspace().then(() => {
                        if (currentFile) {
                            fetch(`/api/workspace/${encodeURIComponent(currentFile)}`)
                                .then(r => r.json())
                                .then(fileData => {
                                    if (fileData.content !== undefined) {
                                        if (diffForRender) {
                                            // Show inline diff in the editor, then transition to clean
                                            renderWithInlineDiff(fileData.content, diffForRender);
                                        } else {
                                            currentContent = fileData.content;
                                            renderDocument(currentContent);
                                        }
                                    }
                                });
                        } else {
                            if (workspaceFiles.length > 0) {
                                loadFile(workspaceFiles[workspaceFiles.length - 1].name);
                            }
                        }
                    });

                } else if (data.type === 'text') {
                    if (!agentMessageEl) {
                        agentMessageEl = appendMessage('agent', data.content);
                    } else {
                        const raw = (agentMessageEl.getAttribute('data-raw') || '') + data.content;
                        agentMessageEl.setAttribute('data-raw', raw);
                        agentMessageEl.innerHTML = marked.parse(raw);
                    }
                    scrollChat();
                }
            }

        } catch (error) {
            console.error('Chat error:', error);
            hideTyping();
            appendMessage('agent', 'Connection error. Please try again.');
        } finally {
            hideTyping();
            isSending = false;
            sendBtn.disabled = false;
            setStatus('ready', 'var(--success)');
            userInput.focus();
        }
    }

    // ---- Event Listeners ----
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    sendBtn.addEventListener('click', sendMessage);
    refreshBtn.addEventListener('click', () => {
        loadWorkspace();
        if (currentFile) loadFile(currentFile);
    });

    // Suggestion chips
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('suggestion-chip')) {
            userInput.value = e.target.dataset.message;
            sendMessage();
        }
    });

    // ---- File Upload ----
    const uploadBtn = document.getElementById('upload-btn');
    const fileUploadInput = document.getElementById('file-upload-input');

    uploadBtn.addEventListener('click', () => fileUploadInput.click());

    fileUploadInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        uploadBtn.classList.add('uploading');
        setStatus('uploading', 'var(--accent)');

        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);

            try {
                const res = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData,
                });
                const data = await res.json();
                if (data.error) {
                    appendMessage('agent', `Upload failed: ${data.error}`);
                } else {
                    let msg = `Uploaded **${data.filename}** (${formatBytes(data.size)})`;
                    if (data.converted) {
                        msg += `\n\nConverted to **${data.converted}**`;
                    }
                    if (data.convert_error) {
                        msg += `\n\nConversion failed: ${data.convert_error}`;
                    }
                    appendMessage('agent', msg);
                    await loadWorkspace();
                    // Open the converted markdown if available, otherwise the original
                    loadFile(data.converted || data.filename);
                }
            } catch (err) {
                appendMessage('agent', `Upload error: ${err.message}`);
            }
        }

        uploadBtn.classList.remove('uploading');
        setStatus('ready', 'var(--success)');
        fileUploadInput.value = '';
    });

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ---- Resizable Split Pane ----
    let isResizing = false;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizeHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const containerWidth = document.querySelector('.editor-layout').offsetWidth;
        const newWidth = Math.max(280, Math.min(e.clientX, containerWidth - 280));
        panelEditor.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });

    // ---- Init ----
    loadWorkspace();
    userInput.focus();
});
