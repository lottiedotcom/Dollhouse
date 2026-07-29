let queueSyncTimeout;
let currentDay = 1;
let currentStashFilter = 'All';
let pendingFilesToUpload = [];
let currentStashActionIndex = null;

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

// --------------------------------------------------------
// SQL DATABASE SYNC ENGINE (With Detailed Error Handling)
// --------------------------------------------------------

async function initQueue() {
    document.getElementById('cloudStatus').innerText = "CONNECTING TO DATABASE...";
    
    try {
        const response = await fetch(`${dbConfig.url}/rest/v1/app_state?id=eq.1`, {
            headers: { 
                'apikey': dbConfig.key, 
                'Authorization': `Bearer ${dbConfig.key}` 
            },
            cache: 'no-store'
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Init Load Failed (${response.status}): ${errText}`);
        }

        const data = await response.json();
        if (data && data.length > 0) {
            const dbState = data[0];
            appData.schedule = dbState.schedule || appData.schedule;
            appData.savedTags = dbState.saved_tags || [];
            appData.stash = dbState.stash || [];
            appData.slots = dbState.slots || {};
        }

        document.getElementById('cloudStatus').innerText = "(★) DATABASE SYNCED & SECURE";
        
        await preloadAllImages();
        renderApp();
    } catch (err) {
        console.error("Database Sync Error:", err);
        alert(`Database Init Error:\n\n${err.message}`);
        document.getElementById('cloudStatus').innerText = "DATABASE CONNECTION ERROR.";
    }
}

function saveQueueToCloud(silent = false) {
    if (!silent) updateCounters();
    clearTimeout(queueSyncTimeout);
    
    queueSyncTimeout = setTimeout(async () => {
        if (!silent) document.getElementById('cloudStatus').innerText = "SAVING TO DATABASE...";
        
        const payload = {
            schedule: appData.schedule,
            saved_tags: appData.savedTags,
            stash: appData.stash,
            slots: appData.slots
        };

        try {
            const res = await fetch(`${dbConfig.url}/rest/v1/app_state?id=eq.1`, {
                method: 'PATCH',
                headers: { 
                    'apikey': dbConfig.key, 
                    'Authorization': `Bearer ${dbConfig.key}`, 
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Auto-Save Failed (${res.status}): ${errText}`);
            }

            if (!silent) document.getElementById('cloudStatus').innerText = "(★) QUEUE SAVED";
        } catch (err) {
            if (!silent) {
                document.getElementById('cloudStatus').innerText = "SAVE FAILED.";
                alert(`Auto-Save Error:\n\n${err.message}`);
            }
        }
    }, 500);
}

// LOCAL-ONLY TEXT EDITING (Does not force save on every keystroke)
function updateCaptionTextLocally(id, text) {
    if (!appData.slots[id]) appData.slots[id] = { images: [], caption: "" };
    appData.slots[id].caption = text;
    updateCounters();
}

// INDEPENDENT MANUAL CAPTION SAVE BUTTON
function saveCaptionManually(event, id) {
    const el = document.getElementById(`caption-${id}`);
    if(el) {
        if (!appData.slots[id]) appData.slots[id] = { images: [], caption: "" };
        appData.slots[id].caption = el.value;
    }
    
    const btn = event.target;
    btn.innerText = "Saving...";
    document.getElementById('cloudStatus').innerText = "SAVING CAPTION TO DB...";
    
    const payload = { slots: appData.slots };

    fetch(`${dbConfig.url}/rest/v1/app_state?id=eq.1`, {
        method: 'PATCH',
        headers: { 
            'apikey': dbConfig.key, 
            'Authorization': `Bearer ${dbConfig.key}`, 
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        body: JSON.stringify(payload)
    }).then(async res => {
        if(res.ok) {
            document.getElementById('cloudStatus').innerText = "(★) CAPTION SECURED";
            btn.innerText = "✓ Saved!";
            setTimeout(() => btn.innerText = "💾 Save Caption", 2000);
            hydrateSlotUI(id);
        } else {
            const errText = await res.text();
            document.getElementById('cloudStatus').innerText = "SAVE FAILED.";
            btn.innerText = "❌ Error";
            alert(`Caption Save Error (${res.status}):\n\n${errText}`);
            setTimeout(() => btn.innerText = "💾 Save Caption", 2000);
        }
    }).catch(err => {
        btn.innerText = "❌ Network Error";
        alert(`Caption Network Error:\n\n${err.message}`);
        setTimeout(() => btn.innerText = "💾 Save Caption", 2000);
    });
}

// --------------------------------------------------------
// PHOTO VAULT STORAGE ENGINE (With Exact Error Reporting)
// --------------------------------------------------------

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
        throw new Error(`Vault Upload Rejected (${res.status}): ${errText}`);
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
                console.error("Failed to load image from vault:", fileName);
            }
        }
    }
}

// --------------------------------------------------------
// CORE APP LOGIC & UI RENDERING
// --------------------------------------------------------

function changeDay(delta) {
    document.querySelectorAll('.caption-box').forEach(el => {
        const id = el.id.replace('caption-', '');
        if (!appData.slots[id]) appData.slots[id] = { images: [], caption: "" };
        appData.slots[id].caption = el.value;
    });

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
    
    if(appData.slots) {
        Object.keys(appData.slots).forEach(id => {
            const slot = appData.slots[id];
            const hasImages = slot.images && slot.images.length > 0;
            const hasCaption = slot.caption && slot.caption.trim() !== "";
            if (hasImages || hasCaption) filledSlots++;
        });
    }

    const header = document.getElementById('headerCounters');
    if(header) header.innerHTML = `Stashed: <b>${stashCount}</b> &nbsp;|&nbsp; Slots Filled: <b>${filledSlots}</b> / ${totalSlots}`;
    
    const stashWarning = document.getElementById('stashWarning');
    if(stashWarning) stashWarning.style.display = stashCount >= 15 ? 'block' : 'none';
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
            
            <textarea class="caption-box" id="caption-${id}" placeholder="Type your caption here..." oninput="updateCaptionTextLocally('${id}', this.value)"></textarea>
            <button class="action-btn" style="background: var(--baby-blue); border-color: var(--dark-blue); margin-bottom: 10px; margin-top: 0;" onclick="saveCaptionManually(event, '${id}')">💾 Save Caption</button>
            
            <div id="btnGroup-${id}" style="display: none; flex-direction: column; gap: 5px;">
                <button class="action-btn" onclick="prepForPost('${id}')">(ﾉ◕ヮ◕)ﾉ Download Photos & Copy Caption</button>
                <button class="action-btn posted" onclick="markAsPosted('${id}')">(★) Mark Posted (Delete from DB)</button>
                <button class="action-btn clear" onclick="clearSlot('${id}')">[X] Clear Slot (Return to Stash)</button>
            </div>
        </div>
    `;
}

function hydrateSlotUI(id) {
    const data = appData.slots[id] || { images: [], caption: "" };
    
    const captionEl = document.getElementById(`caption-${id}`);
    if(captionEl) captionEl.value = data.caption || "";
    
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
    } else if (data.caption && data.caption.trim() !== "") {
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

async function uploadDirectToSlot(event, id) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    if (!appData.slots[id]) appData.slots[id] = { images: [], caption: "" };
    
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
            alert(`Direct Slot Upload Error:\n\n${e.message}`);
        }
    }

    pBar.style.width = '100%';
    statusEl.innerText = "(★) UPLOAD COMPLETE";
    hydrateSlotUI(id);
    saveQueueToCloud();
    event.target.value = ""; 
    
    setTimeout(() => { pContainer.style.display = 'none'; }, 1000);
}

function clearSlot(id) {
    if (appData.slots[id] && appData.slots[id].images && appData.slots[id].images.length > 0) {
        appData.slots[id].images.forEach(imgObj => appData.stash.push(imgObj));
    }
    appData.slots[id] = { images: [], caption: "" }; 
    
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
            alert(`Stash Upload Error for ${file.name}:\n\n${err.message}`);
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

function openStashActionModal(index) {
    currentStashActionIndex = index;
    document.getElementById('modalDayDisplay').innerText = currentDay;
    
    const container = document.getElementById('stashActionSlotButtons');
    container.innerHTML = '';
    
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
    
    if (!appData.slots[slotId]) appData.slots[slotId] = { images: [], caption: "" };
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
        const res = await fetch(`${dbConfig.url}/storage/v1/object/vault/${info.vaultKey}`, {
            method: 'DELETE',
            headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` }
        });
        if(!res.ok) {
            const errText = await res.text();
            throw new Error(`Vault Delete Failed (${res.status}): ${errText}`);
        }
    } catch(e) {
        alert(`Stash Delete Error:\n\n${e.message}`);
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
        
        if (!appData.slots[id]) appData.slots[id] = { images: [], caption: "" };
        appData.slots[id].images.push(item);
    }

    renderApp();
    saveQueueToCloud();
    alert(`Successfully pulled ${amount} item(s) into empty slots on Day ${currentDay}! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧`);
}

async function prepForPost(id) {
    const data = appData.slots[id];
    if (!data) return;

    const el = document.getElementById(`caption-${id}`);
    const captionText = el ? el.value : data.caption;

    if (captionText) {
        try { await navigator.clipboard.writeText(captionText); } catch (err) {}
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
                } else {
                    const errText = await response.text();
                    alert(`Download Error for ${info.originalName} (${response.status}):\n\n${errText}`);
                }
            } catch (e) {
                alert(`Download Network Error:\n\n${e.message}`);
            }
        }
        document.getElementById('cloudStatus').innerText = "(★) VAULT SYNCED & SECURE";
    }
    alert("Caption copied & files downloaded! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧");
}

// STRICT AUTOMATIC PHOTO CLEANUP (Deletes physical file from Vault AND clears DB)
async function markAsPosted(id) {
    const data = appData.slots[id];
    if (!data || !data.images || data.images.length === 0) return clearSlot(id);

    if(!confirm("Mark posted? This will permanently delete these files from your Supabase Vault storage bucket AND clear the slot.")) return;

    const statusEl = document.getElementById('cloudStatus');

    for (let i = 0; i < data.images.length; i++) {
        const item = data.images[i];
        const info = getImageInfo(item);
        
        statusEl.innerText = `PURGING ITEM ${i + 1} OF ${data.images.length} FROM VAULT STORAGE...`;
        
        try {
            const res = await fetch(`${dbConfig.url}/storage/v1/object/vault/${info.vaultKey}`, {
                method: 'DELETE',
                headers: { 'apikey': dbConfig.key, 'Authorization': `Bearer ${dbConfig.key}` }
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Vault Storage Purge Failed (${res.status}): ${errText}`);
            }
        } catch (err) {
            alert(`Purge Error on file ${info.vaultKey}:\n\n${err.message}`);
        }
    }

    statusEl.innerText = "(★) FILES PERMANENTLY PURGED";
    appData.slots[id] = { images: [], caption: "" };
    
    hydrateSlotUI(id);
    saveQueueToCloud();
    setTimeout(() => alert("Photos completely wiped from Vault Storage & slot cleared! (★^O^★)"), 100);
}

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
    document.getElementById('settingsModal').style.display = 'none';
    renderApp();
    saveQueueToCloud();
}

