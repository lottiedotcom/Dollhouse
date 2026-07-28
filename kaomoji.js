let kaomojiData = [];
let kaomojiSyncTimeout;

async function initKaomoji() {
    try {
        const kResponse = await fetch(`${dbConfig.url}/storage/v1/object/public/vault/kaomoji.json?t=${Date.now()}`, {
            headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` },
            cache: 'no-store'
        });
        if (kResponse.ok) {
            kaomojiData = await kResponse.json();
        }
        renderKaomojiList();
    } catch(e) {
        console.log("No kaomoji dictionary found yet, starting fresh.");
    }
}

function saveKaomojiToCloud() {
    document.getElementById('cloudStatus').innerText = "SAVING DICTIONARY...";
    clearTimeout(kaomojiSyncTimeout);
    kaomojiSyncTimeout = setTimeout(async () => {
        try {
            const blob = new Blob([JSON.stringify(kaomojiData)], { type: 'application/json' });
            await fetch(`${dbConfig.url}/storage/v1/object/vault/kaomoji.json`, {
                method: 'POST',
                headers: { 
                    'apikey': dbConfig.key, 
                    'Authorization': `Bearer ${dbConfig.key}`, 
                    'Content-Type': 'application/json', 
                    'x-upsert': 'true' 
                },
                body: blob
            });
            document.getElementById('cloudStatus').innerText = "(★) DICTIONARY SAVED";
        } catch (err) {
            document.getElementById('cloudStatus').innerText = "SAVE FAILED. RETRYING...";
        }
    }, 500);
}

function addNewKaomoji() {
    const comboInput = document.getElementById('newKCombo').value.trim();
    const tagsInput = document.getElementById('newKTags').value;

    if (!comboInput) return alert("Please paste an emoji combo first!");

    // Clean up tags into a clean array
    const tagArray = tagsInput.split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t !== "");

    const newEntry = {
        id: Date.now().toString(),
        combo: comboInput,
        tags: tagArray
    };

    kaomojiData.unshift(newEntry); // Add to top

    document.getElementById('newKCombo').value = '';
    document.getElementById('newKTags').value = '';

    renderKaomojiList();
    saveKaomojiToCloud();
}

function renderKaomojiList() {
    const container = document.getElementById('kaomoji-list-container');
    const searchTerm = document.getElementById('searchKTags').value.trim().toLowerCase();

    const filtered = kaomojiData.filter(item => {
        if (!searchTerm) return true;
        return item.combo.toLowerCase().includes(searchTerm) || item.tags.some(t => t.includes(searchTerm));
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:#aaa; font-size:12px; margin-top:20px;">No combos found...</div>`;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const tagsHtml = item.tags.map(t => `<span class="k-tag">${t}</span>`).join('');
        return `
            <div class="kaomoji-card">
                <div class="kaomoji-text-area">
                    <div class="kaomoji-text">${item.combo}</div>
                    <div class="kaomoji-tags">${tagsHtml}</div>
                </div>
                <div class="k-actions">
                    <button class="btn-copy-k" onclick="copyKaomoji('${item.id}')">📋 Copy</button>
                    <button class="btn-del-k" onclick="deleteKaomoji('${item.id}')">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

async function copyKaomoji(id) {
    const item = kaomojiData.find(k => k.id === id);
    if (item) {
        try {
            await navigator.clipboard.writeText(item.combo);
            document.getElementById('cloudStatus').innerText = "COPIED TO CLIPBOARD!";
            setTimeout(() => document.getElementById('cloudStatus').innerText = "(★) VAULT SYNCED & SECURE", 2000);
        } catch(e) {
            alert("Copy failed. Your browser might be blocking clipboard access.");
        }
    }
}

function deleteKaomoji(id) {
    if(confirm("Delete this combo forever?")) {
        kaomojiData = kaomojiData.filter(k => k.id !== id);
        renderKaomojiList();
        saveKaomojiToCloud();
    }
}

