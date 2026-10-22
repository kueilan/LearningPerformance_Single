/** 公告獨立存放腳本屬性，不變更成績試算表。 */
function announcementStore_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ANNOUNCEMENTS_V1');
  if (!raw) return { revision: 0, items: [] };
  const store = JSON.parse(raw);
  if (!Array.isArray(store.items)) throw new Error('公告資料格式錯誤，請聯絡管理者');
  return store;
}

function publicAnnouncements_() {
  return announcementStore_().items.filter(function (item) { return item.published === true; })
    .map(function (item) {
      return { id: item.id, title: item.title, body: item.body, updatedAt: item.updatedAt };
    }).sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); });
}

function adminAnnouncements_() { return announcementStore_(); }

function saveAnnouncement_(payload) {
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (!title || title.length > 80) throw new Error('公告標題必填，最多 80 字');
  if (!body || body.length > 1500) throw new Error('公告內容必填，最多 1500 字');
  if (typeof payload.published !== 'boolean') throw new Error('請指定公告是否發布');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const store = announcementStore_();
    if (payload.revision !== store.revision) throw new Error('公告已被其他視窗修改，請重新載入後再儲存');
    const id = String(payload.id || '');
    let index = id ? store.items.findIndex(function (item) { return item.id === id; }) : -1;
    if (id && index < 0) throw new Error('找不到此公告，請重新載入');
    if (!id && store.items.length >= 10) throw new Error('最多保留 10 則公告，請編輯既有公告');
    const item = { id: id || Utilities.getUuid(), title: title, body: body,
      published: payload.published, updatedAt: new Date().toISOString() };
    if (index < 0) store.items.push(item);
    else store.items[index] = item;
    store.revision += 1;
    const json = JSON.stringify(store);
    if (Utilities.newBlob(json).getBytes().length > 8000) throw new Error('公告總內容超過容量，請縮短內容後再儲存');
    PropertiesService.getScriptProperties().setProperty('ANNOUNCEMENTS_V1', json);
    return store;
  } finally { lock.releaseLock(); }
}
