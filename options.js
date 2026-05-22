const API_KEY_STORAGE_KEY = 'yt_api_key';

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('apiKey');
  const status = document.getElementById('status');
  const saveBtn = document.getElementById('save');

  chrome.storage.sync.get(API_KEY_STORAGE_KEY, (data) => {
    if (data[API_KEY_STORAGE_KEY]) {
      input.value = data[API_KEY_STORAGE_KEY];
    }
  });

  saveBtn.addEventListener('click', () => {
    const key = input.value.trim();
    if (!key) {
      status.textContent = 'API key cannot be empty.';
      status.className = 'status err';
      return;
    }
    chrome.storage.sync.set({ [API_KEY_STORAGE_KEY]: key }, () => {
      status.textContent = 'Saved!';
      status.className = 'status ok';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });
});
