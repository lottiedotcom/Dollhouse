let queueSyncTimeout;
let currentDay = 1;
let currentStashFilter = 'All';
let pendingFilesToUpload = [];
let currentStashActionIndex = null;
let reminderInterval;

let appData = {
    schedule: ['09:00', '13:00', '18:00', '22:00'],
    stash: [],
    savedTags: [],
    slots: {}
};

let loadedImages = {};

function getImageInfo(item) {
    if (!item) return { vaultKey: '', originalName: '', tag: 'Untagged' };
    if (typeof item === 'object' && item.vaultKey) {
        let name = item.originalName || item.vaultKey;
        name = name.replace(/^QUEUE_DUMP_[^_]*_?/, '');
        return { vaultKey: item.vaultKey, originalName: name, tag: item.tag || 'Untagged' };
    }
    let vaultKey = item;
    let originalName = item;
    if (item.includes('___')) {
        originalName = item.split('___').slice(1).join('___');
    } else {
        originalName = item.replace(/^\d+_/, '');
    }
    originalName = originalName.replace(/^QUEUE_DUMP_[^_]*_?/, '');
    return { vaultKey, originalName, tag: 'Untagged' };
}

async function initQueue() {
    document.getElementById('cloudStatus').innerText = "SYNCING QUEUE...";
    try {
        const response = await fetch(`${dbConfig.url}/storage/v1/object/public/vault/state.json?t=${Date.now()}`, {
            headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` },
            cache: 'no-store'
        });
        
        if (response.ok) {
            const json = await response.json();
            appData = { ...appData, ...json };
            if (!appData.savedTags) appData.savedTags = [];
            
            let migrated = false;
            Object.keys(appData.slots).forEach(key => {
                if(!key.startsWith('d1-') && !key.startsWith('d2-') && !key.startsWith('d3-')) {
                    appData.slots[`d1-${key}`] = appData.slots[key];
                    delete appData.slots[key];
                    migrated = true;
                }
            });
            if(migrated) saveQueueToCloud();
        }

        document.getElementById('cloudStatus').innerText = "(★) VAULT SYNCED & SECURE";
        
        await preloadAllImages();
        renderApp();
        startReminderChecker();
    } catch (err) {
        console.error("Queue Sync Error:", err);
    }
}

function saveQueueToCloud() {
    document.getElementById('cloudStatus').innerText = "SAVING QUEUE...";
    updateCounters();
    clearTimeout(queueSyncTimeout);
    queueSyncTimeout = setTimeout(async () => {
        try {
            const blob = new Blob([JSON.stringify(appData)], { type: 'application/json' });
            await fetch(`${dbConfig.url}/storage/v1/object/vault/state.json`, {
                method: 'POST',
                headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}`, 'Content-Type': 'application/json', 'x-upsert': 'true' },
                body: blob
            });
            document.getElementById('cloudStatus').innerText = "(★) QUEUE SAVED";
        } catch (err) {
            document.getElementById('cloudStatus').innerText = "SAVE FAILED. RETRYING...";
        }
    }, 1000);
}

// RAW ARRAY BUFFER UPLOAD
async function uploadFileToVault(file) {
    const cleanName = file.name.replace(/[^a-zA-Z0-9.]/g, '');
    const fileName = `${Date.now()}_${cleanName}`;
    
    const arrayBuffer = await file.arrayBuffer();
    await new Promise(r => setTimeout(r, 50));

    const res = await fetch(`${dbConfig.url}/storage/v1/object/vault/${fileName}`, {
        method: 'POST',
        headers: { 
            'apikey': dbConfig.key, 
            'Authorization': `Bearer ${dbConfig.key}`, 
            'Content-Type': file.type || 'image/jpeg' 
        },
        body: arrayBuffer
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Upload rejected (${res.status}): ${errText}`);
    }

    loadedImages[fileName] = URL.createObjectURL(file);
    return fileName;
}

async function preloadAllImages() {
    let filesToFetch = [];
    appData.stash.forEach(item => filesToFetch.push(getImageInfo(item).vaultKey));
    
    Object.values(appData.slots).forEach(slot => {
        if (slot.images) slot.images.forEach(item => filesToFetch.push(getImageInfo(item).vaultKey));
    });

    for (let fileName of filesToFetch) {
        if (fileName && !loadedImages[fileName]) {
            try {
                const response = await fetch(`${dbConfig.url}/storage/v1/object/vault/${fileName}`, {
                    headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` }
                });
                if (response.ok) {
                    const blob = await response.blob();
                    loadedImages[fileName] = URL.createObjectURL(blob);
                }
            } catch (e) {
                console.error("Failed to load image:", fileName);
            }
        }
    }
}

function changeDay(delta) {
    currentDay += delta;
    if(currentDay < 1) currentDay = 1;
    if(currentDay > 3) currentDay = 3;
    document.getElementById('dayDisplay').innerText = `Day ${currentDay}`;
    renderApp();
}

function updateCounters() {
    const stashCount = appData.stash.length;
    const totalSlots = appData.schedule.length * 3;
    let filledSlots = 0;
    Object.values(appData.slots).forEach(slot => {
        if ((slot.images && slot.images.length > 0) || slot.caption) filledSlots++;
    });

    document.getElementById('headerCounters').innerHTML = `Stashed: <b>${stashCount}</b> &nbsp;|&nbsp; Slots Filled: <b>${filledSlots}</b> / ${totalSlots}`;
    document.getElementById('stashWarning').style.display = stashCount >= 15 ? 'block' : 'none';
}

function renderApp() {
    appData.schedule.sort();
    const schedContainer = document.getElementById('scheduled-container');
    
    schedContainer.innerHTML = '';
    appData.schedule.forEach((time, index) => {
        const id = `d${currentDay}-sched-${index}`;
        schedContainer.innerHTML += createSlotHTML(id, `Post ${index + 1} - ${formatTime(time)}`);
        hydrateSlotUI(id);
    });

    renderStash();
    updateCounters();
}

function createSlotHTML(id, title) {
    return `
        <div class="slot" id="slot-${id}">
            <div class="slot-title">${title}</div>
            <input type="file" multiple accept="image/*,image/gif" onchange="uploadDirectToSlot(event, '${id}')">
            <div class="slot-gallery" id="gallery-${id}" style="display: none;"></div>
            <textarea class="caption-box" id="caption-${id}" placeholder="Type your caption here... (Auto-saves)" oninput="updateCaption('${id}', this.value)"></textarea>
            <div id="btnGroup-${id}" style="display: none; flex-direction: column; gap: 5px;">
                <button class="action-btn" onclick="prepForPost('${id}')">(ﾉ◕ヮ◕)ﾉ Download Photos & Copy Caption</button>
                <button class="action-btn posted" onclick="markAsPosted('${id}')">(★) Mark Posted (Delete from DB)</button>
                <button class="action-btn clear" onclick="clearSlot('${id}')">[X] Clear Slot (Return to Stash)</button>
            </div>
        </div>
    `;
}

function hydrateSlotUI(id) {
    if(!appData.slots[id]) return;
    const data = appData.slots[id];
    
    document.getElementById(`caption-${id}`).value = data.caption || "";
    
    const gallery = document.getElementById(`gallery-${id}`);
    const btnGroup = document.getElementById(`btnGroup-${id}`);
    
    if (data.images && data.images.length > 0) {
        gallery.innerHTML = data.images.map((item, imgIndex) => {
            const info = getImageInfo(item);
            const url = loadedImages[info.vaultKey] || '';
            return `<div class="gallery-item"><img src="${url}" onclick="removeSingleImageFromSlot('${id}', ${imgIndex})" title="Click to return to Stash"></div>`;
        }).join('');
        gallery.style.display = 'flex';
        btnGroup.style.display = 'flex';
    } else if (data.caption) {
        gallery.style.display = 'none';
        btnGroup.style.display = 'flex';
    } else {
        gallery.style.display = 'none';
        btnGroup.style.display = 'none';
    }
}

function formatTime(time24h) {
    let [hours, minutes] = time24h.split(':');
    let ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12; 
    return `${hours}:${minutes} ${ampm}`;
}

// STRICT 1-by-1 Upload with Visual Progress Bar
async function uploadDirectToSlot(event, id) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    if (!appData.slots[id]) appData.slots[id] = { caption: "", images: [] };
    
    const statusEl = document.getElementById('cloudStatus');
    const pContainer = document.getElementById('globalProgressContainer');
    const pBar = document.getElementById('globalProgressBar');
    
    pContainer.style.display = 'block';
    pBar.style.width = '0%';
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        statusEl.innerText = `UPLOADING ${i + 1} OF ${files.length}...`;
        pBar.style.width = `${((i) / files.length) * 100}%`;
        
        try {
            const fileName = await uploadFileToVault(file);
            appData.slots[id].images.push({ vaultKey: fileName, originalName: file.name, tag: 'Direct' });
        } catch(e) {
            alert(`Failed to upload ${file.name}: ${e.message}`);
        }
    }

    pBar.style.width = '100%';
    statusEl.innerText = "(★) UPLOAD COMPLETE";
    hydrateSlotUI(id);
    saveQueueToCloud();
    event.target.value = ""; 
    
    setTimeout(() => { pContainer.style.display = 'none'; }, 1000);
}

function updateCaption(id, text) {
    if (!appData.slots[id]) appData.slots[id] = { caption: "", images: [] };
    appData.slots[id].caption = text;
    saveQueueToCloud();
    hydrateSlotUI(id);
}

function clearSlot(id) {
    if (appData.slots[id] && appData.slots[id].images && appData.slots[id].images.length > 0) {
        appData.slots[id].images.forEach(imgObj => appData.stash.push(imgObj));
    }
    appData.slots[id] = { caption: "", images: [] };
    hydrateSlotUI(id);
    renderStash();
    saveQueueToCloud();
}

function removeSingleImageFromSlot(id, index) {
    if (appData.slots[id] && appData.slots[id].images && appData.slots[id].images.length > index) {
        const removedItem = appData.slots[id].images.splice(index, 1)[0];
        appData.stash.push(removedItem);
        hydrateSlotUI(id);
        renderStash();
        saveQueueToCloud();
    }
}

function clearAllSlots() {
    if(confirm("Are you sure you want to clear ALL 3 Days of slots? (Photos will return to your Stash)")) {
        Object.keys(appData.slots).forEach(id => {
            if (appData.slots[id] && appData.slots[id].images) {
                appData.slots[id].images.forEach(imgObj => appData.stash.push(imgObj));
            }
        });
        appData.slots = {};
        renderApp();
        saveQueueToCloud();
    }
}

function updateStashFilter() {
    currentStashFilter = document.getElementById('stashFilter').value;
    renderStash();
}

function previewSelectedFiles(event) {
    pendingFilesToUpload = Array.from(event.target.files);
    let totalMB = pendingFilesToUpload.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);
    document.getElementById('uploadStatusText').innerText = `${pendingFilesToUpload.length} file(s) selected (${totalMB.toFixed(1)}MB total) ready to upload.`;
}

// Upload to Stash with Progress Bar
async function uploadAndSaveTag() {
    if (pendingFilesToUpload.length === 0) return alert("Please click '+ Select Photos' first!");
    
    let tagInput = document.getElementById('newUploadTagInput').value.trim();
    if (!tagInput) {
        tagInput = document.getElementById('uploadTagSelect').value;
    }
    if (!tagInput) return alert("Please select an existing tag from the dropdown or type a new one!");

    if (!appData.savedTags) appData.savedTags = [];
    if (!appData.savedTags.includes(tagInput)) appData.savedTags.push(tagInput);

    const statusEl = document.getElementById('uploadStatusText');
    const pContainer = document.getElementById('globalProgressContainer');
    const pBar = document.getElementById('globalProgressBar');
    
    pContainer.style.display = 'block';
    pBar.style.width = '0%';
    let successCount = 0;

    for (let i = 0; i < pendingFilesToUpload.length; i++) {
        const file = pendingFilesToUpload[i];
        pBar.style.width = `${((i) / pendingFilesToUpload.length) * 100}%`;
        
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        statusEl.innerText = `Uploading ${i + 1} of ${pendingFilesToUpload.length}: ${file.name} (${sizeMB}MB)...`;
        
        try {
            const fileName = await uploadFileToVault(file);
            appData.stash.push({ vaultKey: fileName, originalName: file.name, tag: tagInput });
            successCount++;
        } catch (err) {
            alert(`Failed to upload ${file.name}:\n\n${err.message}`);
        }
    }

    pBar.style.width = '100%';
    pendingFilesToUpload = [];
    document.getElementById('stashFileSelect').value = "";
    document.getElementById('newUploadTagInput').value = "";
    statusEl.innerText = `(★) Uploaded ${successCount} file(s) & saved to tag: ${tagInput}`;
    
    setTimeout(() => { pContainer.style.display = 'none'; }, 1000);
    
    currentStashFilter = tagInput; 
    renderStash();
    saveQueueToCloud();
}

function renderStash() {
    updateCounters();
    const previewContainer = document.getElementById('stashPreview');
    const filterDropdown = document.getElementById('stashFilter');
    const uploadTagSelect = document.getElementById('uploadTagSelect');
    
    if (!appData.savedTags) appData.savedTags = [];

    const allTags = new Set([...appData.savedTags]);
    appData.stash.forEach(item => allTags.add(getImageInfo(item).tag));
    
    let filterOptions = `<option value="All">View All Tags (${appData.stash.length})</option>`;
    allTags.forEach(tag => {
        const count = appData.stash.filter(i => getImageInfo(i).tag === tag).length;
        const selected = tag === currentStashFilter ? 'selected' : '';
        filterOptions += `<option value="${tag}" ${selected}>${tag} (${count})</option>`;
    });
    filterDropdown.innerHTML = filterOptions;

    let uploadOptions = `<option value="">-- Choose Existing Tag --</option>`;
    allTags.forEach(tag => {
        uploadOptions += `<option value="${tag}">${tag}</option>`;
    });
    uploadTagSelect.innerHTML = uploadOptions;

    let html = '';
    appData.stash.forEach((item, originalIndex) => {
        const info = getImageInfo(item);
        if(currentStashFilter === 'All' || info.tag === currentStashFilter) {
            const url = loadedImages[info.vaultKey] || '';
            let displayTag = info.tag !== 'Untagged' ? `<div class="stash-tag-badge">${info.tag}</div>` : '';
            // New Modal click trigger instead of instant delete
            html += `
                <div class="stash-thumb-wrapper">
                    <img src="${url}" class="stash-thumb" onclick="openStashActionModal(${originalIndex})" title="Click for options">
                    ${displayTag}
                </div>`;
        }
    });

    if (html === '') {
        previewContainer.innerHTML = '<span style="font-size: 12px; color: #aaa;">No items match this tag...</span>';
    } else {
        previewContainer.innerHTML = html;
    }
}

// --- NEW STASH PICKER MODAL ---
function openStashActionModal(index) {
    currentStashActionIndex = index;
    document.getElementById('modalDayDisplay').innerText = currentDay;
    
    const container = document.getElementById('stashActionSlotButtons');
    container.innerHTML = '';
    
    // Generate dynamic buttons for the current day's slots
    appData.schedule.forEach((time, i) => {
        const btn = document.createElement('button');
        btn.className = 'btn-style';
        btn.style.width = '100%';
        btn.style.marginBottom = '8px';
        btn.style.background = '#e6f2ff';
        btn.innerText = `Move to Post ${i + 1} (${formatTime(time)})`;
        btn.onclick = () => executeStashMove(i);
        container.appendChild(btn);
    });

    document.getElementById('stashActionModal').style.display = 'flex';
}

function closeStashActionModal() {
    document.getElementById('stashActionModal').style.display = 'none';
    currentStashActionIndex = null;
}

function executeStashMove(slotIndex) {
    if(currentStashActionIndex === null) return;
    
    const item = appData.stash.splice(currentStashActionIndex, 1)[0];
    const slotId = `d${currentDay}-sched-${slotIndex}`;
    
    if (!appData.slots[slotId]) appData.slots[slotId] = { caption: "", images: [] };
    appData.slots[slotId].images.push(item);
    
    renderApp();
    saveQueueToCloud();
    closeStashActionModal();
}

async function executeStashDelete() {
    if(currentStashActionIndex === null) return;
    if(!confirm("Permanently delete this photo from your Vault Database?")) return;
    
    const item = appData.stash[currentStashActionIndex];
    const info = getImageInfo(item);
    
    document.getElementById('cloudStatus').innerText = "DELETING FROM VAULT...";
    try {
        await fetch(`${dbConfig.url}/storage/v1/object/vault/${info.vaultKey}`, {
            method: 'DELETE',
            headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` }
        });
    } catch(e) {
        console.error("Failed to delete file from DB:", info.vaultKey);
    }
    
    appData.stash.splice(currentStashActionIndex, 1);
    renderApp();
    saveQueueToCloud();
    closeStashActionModal();
    document.getElementById('cloudStatus').innerText = "(★) VAULT SYNCED & SECURE";
}

function autoFillDayCustom() {
    let eligibleIndices = [];
    appData.stash.forEach((item, idx) => {
        const info = getImageInfo(item);
        if (currentStashFilter === 'All' || info.tag === currentStashFilter) {
            eligibleIndices.push(idx);
        }
    });

    if (eligibleIndices.length === 0) return alert("No items found in the current tag filter to auto-slot!");

    let amountStr = document.getElementById('autoFillAmount').value;
    let amount = parseInt(amountStr);

    if (amount > eligibleIndices.length) amount = eligibleIndices.length;

    const schedContainer = document.getElementById('scheduled-container');
    const allSlots = Array.from(schedContainer.querySelectorAll('.slot'));
    
    const emptySlots = allSlots.filter(slotNode => {
        const id = slotNode.id.replace('slot-', '');
        return !appData.slots[id] || !appData.slots[id].images || appData.slots[id].images.length === 0;
    });

    if (emptySlots.length === 0) return alert("There are no empty slots left on this day! Clear a slot first.");

    eligibleIndices.sort(() => Math.random() - 0.5);

    let itemsToSlot = [];
    let pulledIndices = eligibleIndices.slice(0, amount).sort((a, b) => b - a);
    pulledIndices.forEach(idx => itemsToSlot.push(appData.stash.splice(idx, 1)[0]));
    itemsToSlot.sort(() => Math.random() - 0.5);

    while (itemsToSlot.length > 0) {
        const item = itemsToSlot.shift();
        const randomSlotNode = emptySlots[Math.floor(Math.random() * emptySlots.length)];
        const id = randomSlotNode.id.replace('slot-', '');
        
        if (!appData.slots[id]) appData.slots[id] = { caption: "", images: [] };
        appData.slots[id].images.push(item);
    }

    renderApp();
    saveQueueToCloud();
    alert(`Successfully pulled ${amount} item(s) into empty slots on Day ${currentDay}! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧`);
}

async function prepForPost(id) {
    const data = appData.slots[id];
    if (!data) return;

    if (data.caption) {
        try { await navigator.clipboard.writeText(data.caption); } catch (err) {}
    }

    if (data.images && data.images.length > 0) {
        for (let i = 0; i < data.images.length; i++) {
            const info = getImageInfo(data.images[i]);
            try {
                document.getElementById('cloudStatus').innerText = `DOWNLOADING ITEM ${i + 1} OF ${data.images.length}...`;
                const response = await fetch(`${dbConfig.url}/storage/v1/object/vault/${info.vaultKey}?t=${Date.now()}`, {
                    headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` },
                    cache: 'no-store'
                });
                
                if (response.ok) {
                    const blob = await response.blob();
                    const reader = new FileReader();
                    await new Promise((resolve) => {
                        reader.onloadend = () => {
                            const a = document.createElement('a');
                            a.style.display = 'none';
                            a.href = reader.result;
                            a.download = info.originalName;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            resolve();
                        };
                        reader.readAsDataURL(blob);
                    });
                    if (i < data.images.length - 1) await new Promise(resolve => setTimeout(resolve, 3500));
                }
            } catch (e) {}
        }
        document.getElementById('cloudStatus').innerText = "(★) VAULT SYNCED & SECURE";
    }
    alert("Caption copied & files downloaded! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧");
}

async function markAsPosted(id) {
    const data = appData.slots[id];
    if (!data || !data.images) return clearSlot(id);

    if(!confirm("Mark posted? This will permanently delete these files from your Supabase Vault database to save space.")) return;

    const statusEl = document.getElementById('cloudStatus');

    for (let i = 0; i < data.images.length; i++) {
        const item = data.images[i];
        const info = getImageInfo(item);
        
        statusEl.innerText = `DELETING ITEM ${i + 1} OF ${data.images.length} FROM VAULT...`;
        
        try {
            await fetch(`${dbConfig.url}/storage/v1/object/vault/${info.vaultKey}`, {
                method: 'DELETE',
                headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` }
            });
        } catch (err) {
            console.error("Failed to delete file from DB:", info.vaultKey);
        }
    }

    statusEl.innerText = "(★) FILES PERMANENTLY DELETED";
    appData.slots[id] = { caption: "", images: [] };
    hydrateSlotUI(id);
    saveQueueToCloud();
    setTimeout(() => alert("Deleted entirely from Vault & cleared slot (★^O^★)"), 100);
}

// --- SETTINGS & REMINDERS ---
function openSettings() {
    const container = document.getElementById('scheduleInputsContainer');
    container.innerHTML = '';
    appData.schedule.forEach((time, index) => {
        container.innerHTML += `
            <div class="time-row" id="time-row-${index}">
                <input type="time" class="input-field" style="margin:0; width:150px;" value="${time}">
                <button class="remove-btn" onclick="this.parentElement.remove()">X</button>
            </div>
        `;
    });
    
    const savedReminder = localStorage.getItem('queueReminderTime') || '';
    document.getElementById('reminderTimeInput').value = savedReminder;

    document.getElementById('settingsModal').style.display = 'flex';
}

function addTimeInput() {
    const container = document.getElementById('scheduleInputsContainer');
    const div = document.createElement('div');
    div.className = 'time-row';
    div.innerHTML = `
        <input type="time" class="input-field" style="margin:0; width:150px;" value="12:00">
        <button class="remove-btn" onclick="this.parentElement.remove()">X</button>
    `;
    container.appendChild(div);
}

function saveAndCloseSettings() {
    const inputs = document.querySelectorAll('#scheduleInputsContainer input[type="time"]');
    let newTimes = [];
    inputs.forEach(input => { if(input.value) newTimes.push(input.value); });
    appData.schedule = newTimes;
    
    // Save Reminder Time
    const reminderTime = document.getElementById('reminderTimeInput').value;
    localStorage.setItem('queueReminderTime', reminderTime);
    startReminderChecker();

    document.getElementById('settingsModal').style.display = 'none';
    renderApp();
    saveQueueToCloud();
}

// NOTIFICATION CHECKER
function startReminderChecker() {
    if(reminderInterval) clearInterval(reminderInterval);
    const reminderTime = localStorage.getItem('queueReminderTime');
    if(!reminderTime) return;

    reminderInterval = setInterval(() => {
        const now = new Date();
        const h = now.getHours().toString().padStart(2, '0');
        const m = now.getMinutes().toString().padStart(2, '0');
        const currentTime = `${h}:${m}`;
        
        const lastNotified = localStorage.getItem('lastNotifiedDate');
        const today = now.toDateString();

        if(currentTime === reminderTime && lastNotified !== today) {
            playBeepSound();
            if(Notification.permission === "granted") {
                new Notification("(★) Queue Manager", { body: "Time to schedule your posts for 3 days out!" });
            } else {
                alert("(★) Time to schedule your posts for 3 days out!");
            }
            localStorage.setItem('lastNotifiedDate', today);
        }
    }, 60000); // Checks the clock every 60 seconds
}

function playBeepSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3); // Quick 0.3s notification chime
    } catch(e) {
        console.error("Audio block on mobile:", e);
    }
}

