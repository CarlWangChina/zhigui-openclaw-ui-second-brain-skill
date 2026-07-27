const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ensureDataInitialized } = require('../lib/init-data');
const Storage = require('../engine/storage');
const Actions = require('../engine/actions');

const port = 17991;
const skillDir = path.join(__dirname, '..');
const output = path.resolve(skillDir, '..', 'reports', 'dashboard-preview.png');
const notesOutput = path.resolve(skillDir, '..', 'reports', 'notes-preview.png');
const knowledgeOutput = path.resolve(skillDir, '..', 'reports', 'knowledge-preview.png');
let server = null;
const consoleErrors = [];
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-dashboard-ui-'));

function seedDashboardData() {
  ensureDataInitialized(testDataDir);
  Storage.setDataDir(testDataDir);
  Actions.configure(testDataDir);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  Actions.execute('event.add', { date: today, time: '10:00', duration: 50, title: 'Review the onboarding flow', priority: 82 });
  const action = Actions.execute('errand.add', { title: 'Invite a friend to test', date: yesterday, time: '14:00', duration: 30, priority: 'should' });
  Actions.execute('errand.add', { title: 'Collect feedback later', date: today, priority: 'nice' });
  Actions.execute('note.add', {
    title: 'Clear writing needs a visible outcome', topic: 'Product clarity', category: 'Product method',
    content: 'Every irreversible interface action needs a clear in-progress, success and error state.', source: 'test fixture',
  });
  const rawNote = Actions.execute('note.add', { content: 'An imported-style raw note waits for AI organization.', source: 'test fixture' });
  Actions.execute('note.propose_enrichment', {
    id: rawNote.note.id, title: 'Imported notes need confirmation', topic: 'Information intake', category: 'Personal system',
    reason: 'The original note should keep its wording until the user accepts this structure.',
    conflicts: ['Confirm whether this belongs in a long-term knowledge topic.'],
  });
  return action;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview server timed out')), 8000);
    const inspect = chunk => {
      if (String(chunk).includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => reject(new Error(`Preview server exited (${code})`)));
  });
}

app.whenReady().then(async () => {
  try {
    seedDashboardData();
    server = spawn(process.execPath, ['dashboard/server.js'], {
      cwd: skillDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LINGXI_PORT: String(port), LINGXI_DATA_DIR: testDataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(server);
    const win = new BrowserWindow({
      show: false,
      width: 420,
      height: 980,
      backgroundColor: '#101513',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('console-message', details => {
      if (details.level === 'warning' || details.level === 'error') consoleErrors.push(details.message);
    });
    await win.loadURL(`http://127.0.0.1:${port}`);
    await new Promise(resolve => setTimeout(resolve, 1800));

    const smoke = await win.webContents.executeJavaScript(`(async () => {
      showView('knowledge');
      // renderTopics fetches its index asynchronously; wait for the cards rather than
      // assuming a fixed response time from the local dashboard server.
      for (let attempt = 0; attempt < 12 && !document.querySelector('.topic-card'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      let topic = null;
      let topicExpanded = false;
      let topicNote = null;
      for (const candidate of document.querySelectorAll('.topic-card')) {
        candidate.querySelector('.topic-head')?.click();
        // Topic notes load on demand; allow the local IPC/server refresh to settle on slower machines.
        await new Promise(resolve => setTimeout(resolve, 350));
        const note = candidate.querySelector('.tree-note');
        if (candidate.classList.contains('expanded') && note) {
          topic = candidate;
          topicNote = note;
          topicExpanded = true;
          break;
        }
      }
      topicNote?.click();
      await new Promise(resolve => setTimeout(resolve, 60));
      const topicNoteBodyVisible = !!topicNote?.querySelector('.tree-note-full')?.textContent?.trim() &&
        getComputedStyle(topicNote.querySelector('.tree-note-full')).display !== 'none';
      showView('all');
      await new Promise(resolve => setTimeout(resolve, 150));
      const noteCard = document.querySelector('.note-card');
      const noteTitle = noteCard?.querySelector('.note-summary')?.textContent?.trim() || '';
      const titleFontSize = noteCard ? parseFloat(getComputedStyle(noteCard.querySelector('.note-summary')).fontSize) : 0;
      const bodyInitiallyHidden = noteCard ? !noteCard.querySelector('.note-content-full') : false;
      noteCard?.querySelector('.note-row')?.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const noteBodyLoaded = !!document.querySelector('.note-card.expanded .note-content-full')?.textContent?.trim();
      const decisionSectionRemoved = !document.getElementById('section-decisions');
      showView('today');
      await new Promise(resolve => setTimeout(resolve, 100));
      const decisionCheckTitle = document.querySelector('#section-briefing .section-title')?.textContent?.trim() || '';
      const decisionCheckText = document.getElementById('briefing-card')?.textContent || '';
      const decisionCheckVisible = getComputedStyle(document.getElementById('section-briefing')).display !== 'none';
      const briefingHasScheduleDuplicate = decisionCheckText.includes('Review the onboarding flow');
      const scheduleShowsEndTime = !!document.querySelector('.task-time-end')?.textContent?.trim();
      const timeEditor = document.querySelector('.task-time-edit');
      const hasTimeEditor = !!timeEditor;
      timeEditor?.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const timeEditorOpens = !!document.getElementById('time-editor-modal') &&
        getComputedStyle(document.getElementById('time-editor-modal')).display !== 'none';
      closeTimeEditor();
      const deleteButton = document.querySelector('.task-delete-btn');
      const hasScheduleDelete = !!deleteButton;
      deleteButton?.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const deleteModalOpens = !!document.getElementById('action-delete-modal') &&
        getComputedStyle(document.getElementById('action-delete-modal')).display !== 'none';
      closeActionDeleteModal();
      const hasImportButton = !!document.querySelector('.note-import-btn');
      const reviewButton = document.getElementById('pending-review-button');
      const hasReviewButton = !!reviewButton;
      reviewButton?.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const reviewModalOpens = !!document.getElementById('pending-review-modal') &&
        getComputedStyle(document.getElementById('pending-review-modal')).display !== 'none';
      const reviewProposalShown = !!document.querySelector('.review-card');
      closePendingReviewModal();
      const queueIsUnscheduled = document.querySelector('#section-errands .section-title')?.textContent?.includes('待安排') ||
        document.querySelector('#section-errands .section-title')?.textContent?.includes('Unscheduled');
      navigateDay(-1);
      await new Promise(resolve => setTimeout(resolve, 100));
      const scheduledActionMerged = !!document.querySelector('.scheduled-action');
      const relatedNotesTitle = document.querySelector('#section-related-notes .section-title')?.textContent?.trim() || '';
      navigateDay(1);
      await new Promise(resolve => setTimeout(resolve, 100));
      showAddErrandForm();
      const modal = document.getElementById('errand-modal');
      const modalOpened = modal && getComputedStyle(modal).display !== 'none';
      closeErrandModal();
      showAddGoalForm('strategicGoal');
      document.getElementById('goal-title').value = 'Desktop action routing works';
      await confirmAddGoal();
      await new Promise(resolve => setTimeout(resolve, 120));
      const desktopGoalAddWorks = (state.strategicGoals || []).some(goal => goal.title === 'Desktop action routing works');
      const noManualReindex = !document.querySelector('.btn-reindex') && typeof reindexTopics === 'undefined';
      document.querySelector('.view-tab[data-view="today"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      return {
        topicExpanded,
        topicNoteBodyVisible,
        noteTitle,
        titleFontSize,
        bodyInitiallyHidden,
        noteBodyLoaded,
        decisionSectionRemoved,
        decisionCheckTitle,
        decisionCheckVisible,
        briefingHasScheduleDuplicate,
        scheduleShowsEndTime,
        hasTimeEditor,
        timeEditorOpens,
        hasScheduleDelete,
        deleteModalOpens,
        hasImportButton,
        hasReviewButton,
        reviewModalOpens,
        reviewProposalShown,
        queueIsUnscheduled,
        relatedNotesTitle,
        scheduledActionMerged,
        modalOpened,
        desktopGoalAddWorks,
        noManualReindex,
        title: document.getElementById('focus-title')?.textContent,
        activeView: document.querySelector('.view-tab.active')?.dataset.view,
        activeSections: [...document.querySelectorAll('.dashboard-body [data-view].view-active')]
          .map(node => node.id || node.className),
        visibleSections: [...document.querySelectorAll('[data-view="today"]')]
          .filter(node => getComputedStyle(node).display !== 'none').length,
      };
    })()`);
    if (!smoke.topicExpanded || !smoke.topicNoteBodyVisible || !smoke.noteTitle || smoke.titleFontSize > 14 || !smoke.bodyInitiallyHidden ||
        !smoke.noteBodyLoaded || !smoke.decisionSectionRemoved || !smoke.decisionCheckVisible || !/(今日判断|Decision check)/.test(smoke.decisionCheckTitle) || smoke.briefingHasScheduleDuplicate || !smoke.scheduleShowsEndTime || !smoke.hasTimeEditor || !smoke.timeEditorOpens || !smoke.queueIsUnscheduled || !smoke.relatedNotesTitle || smoke.relatedNotesTitle === 'section.relatedNotes' ||
        !smoke.hasScheduleDelete || !smoke.deleteModalOpens || !smoke.hasImportButton || !smoke.hasReviewButton || !smoke.reviewModalOpens || !smoke.reviewProposalShown || !smoke.scheduledActionMerged || !smoke.modalOpened || !smoke.desktopGoalAddWorks || !smoke.noManualReindex || !smoke.title || smoke.activeView !== 'today' ||
        smoke.activeSections.includes('section-topics') || smoke.visibleSections === 0) {
      throw new Error(`UI smoke check failed: ${JSON.stringify(smoke)}`);
    }
    if (consoleErrors.length) {
      throw new Error(`Dashboard console errors: ${consoleErrors.join(' | ')}`);
    }

    // Capture the exact note presentation under review: compact AI title, body on demand.
    await win.webContents.executeJavaScript(`localStorage.setItem('lingxi_view', 'all')`);
    await win.reload();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await win.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      document.querySelector('.note-card .note-row')?.click();
      document.querySelectorAll('.dashboard-body [data-view]').forEach(section => {
        if (section.id !== 'section-notes') section.style.display = 'none';
      });
      const notes = document.getElementById('section-notes');
      if (notes) notes.style.display = 'block';
      document.getElementById('dashboard-body').scrollTop = 0;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    const notesImage = await win.capturePage();
    fs.mkdirSync(path.dirname(notesOutput), { recursive: true });
    fs.writeFileSync(notesOutput, notesImage.toPNG());

    // Capture the knowledge tree as well: its note title and metadata must occupy
    // separate rows so metadata chips never squeeze the title into vertical text.
    await win.webContents.executeJavaScript(`localStorage.setItem('lingxi_view', 'knowledge')`);
    await win.reload();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await win.webContents.executeJavaScript(`(async () => {
      const topic = document.querySelector('.topic-card');
      topic?.querySelector('.topic-head')?.click();
      await new Promise(resolve => setTimeout(resolve, 180));
      document.querySelectorAll('.dashboard-body [data-view]').forEach(section => {
        if (section.id !== 'section-topics') section.style.display = 'none';
      });
      document.getElementById('dashboard-body').scrollTop = 0;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    const knowledgeImage = await win.capturePage();
    fs.writeFileSync(knowledgeOutput, knowledgeImage.toPNG());

    // A hidden BrowserWindow can keep the last painted frame after DOM-only view switches.
    // Reload with the persisted "today" view before capturing the visual artifact.
    await win.webContents.executeJavaScript(`localStorage.setItem('lingxi_view', 'today')`);
    await win.reload();
    await new Promise(resolve => setTimeout(resolve, 1200));
    const finalFrame = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.modal-overlay').forEach(modal => { modal.style.display = 'none'; });
      showView('today');
      document.getElementById('dashboard-body').scrollTop = 0;
      window.scrollTo(0, 0);
      const rect = document.getElementById('expanded-panel').getBoundingClientRect();
      return { left: rect.left, width: rect.width, view: document.querySelector('.view-tab.active')?.dataset.view };
    })()`);
    if (finalFrame.view !== 'today' || finalFrame.left > 1 || finalFrame.width < 300) {
      throw new Error(`Final frame is not ready: ${JSON.stringify(finalFrame)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 350));
    const image = await win.capturePage();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, image.toPNG());
    console.log(`PASS dashboard UI smoke: ${JSON.stringify(smoke)}`);
    console.log(notesOutput);
    console.log(knowledgeOutput);
    console.log(output);
    win.destroy();
  } finally {
    if (server) server.kill();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    app.quit();
  }
}).catch(err => {
  console.error(err);
  if (server) server.kill();
  app.exit(1);
});
