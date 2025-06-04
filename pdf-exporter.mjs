import axios from 'axios';
import { writeFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Parse service account JSON string from env
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

// ✅ Load secrets from env
const email = process.env.ATLASSIAN_EMAIL;
const apiToken = process.env.ATLASSIAN_API_TOKEN;
const domain = process.env.ATLASSIAN_DOMAIN;
const FOLDER_ID = process.env.GOOGLE_DRIVE_PARENT_FOLDER;

const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
const keysToDrop = ["Linked Issues", "Votes",  "Log Work", "Time tracking", "ΤΙΜΗ ΒΕΡ", "Work Ratio", "Request participants", "Components", "Progress", "Συνεργείο Εμφύσησης", "Watchers", "[CHART] Time in Status", "Parent Link", "Rank", "Organizations", "Fix versions", "Affects versions", "Σ Progress", "[CHART] Date of First Response", "Συνεργείο Ηλεκτρολόγου", "Συνεργείο Μηχανικού"];

const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+\d{4}$/;

let finalObjMain = {};

console.log("⏳ Sending request to Jira...");

export async function uploadToDrive(filePath, filename, ak, company) {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Step A: Find or create top folder by mainIssue['ΑΚ']
  const topFolderId = await findOrCreateFolder(drive, ak, FOLDER_ID);

  // Step B: Find or create subfolder by mainIssue['Εταιρεία Ανάθεσης']
  const subFolderId = await findOrCreateFolder(drive, company, topFolderId);

  // Step C: Upload inside the subfolder
  const fileMetadata = {
    name: filename,
    parents: [subFolderId],
  };

  const media = {
    mimeType: 'application/pdf',
    body: fs.createReadStream(filePath),
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, webViewLink',
  });

  return res.data.webViewLink;
}

async function findOrCreateFolder(drive, folderName, parentFolderId = 'root') {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId]
  };


  const folder = await drive.files.create({
    resource: fileMetadata,
    fields: 'id'
  });

  return folder.data.id;
}

async function createFolder(folderName, parentFolderId = 'root') {
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId],
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    fields: 'id, name',
  });

  console.log(`✅ Folder created: ${res.data.name} (ID: ${res.data.id})`);
  return res.data.id;
}



function formatDate(raw) {
  const date = new Date(raw);

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0'); // months are 0-based
  const year = date.getFullYear();

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${day}-${month}-${year}  ${hours}:${minutes}:${seconds}`;
}

function dropNull(firstObject, targetObject) {
  for (const key in firstObject) {
    if (firstObject[key] !== null) {
      targetObject[key] = firstObject[key];
    }
  }
}

function extractTextFromAtlassianDoc(doc) {
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return '';

  return doc.content
    .flatMap(paragraph =>
      paragraph.content?.map(c => c.text).filter(Boolean) || []
    )
    .join(' ');
}


function flattenFieldsMainIssue(fields) {
  const result = {};

  for (const key in fields) {
    const value = fields[key];

    if (key === 'Sub-tasks' && Array.isArray(value)) {
      result['Subtasks'] = value.map(subtask => ({
        key: subtask.key || '',
        summary: subtask.fields?.summary || '',
        status: subtask.fields?.status?.name || '',
        priority: subtask.fields?.priority?.name || '',
        issuetype: subtask.fields?.issuetype?.name || ''
      }));
      continue; // Skip default processing for Sub-tasks
    }


    if (key === 'Attachment' && Array.isArray(value)) {
      result['Attachments'] = value.map(att => ({
        filename: att.filename,
        author: att.author?.displayName || '',
        created: att.created,
        content: att.content
      }));
      continue; // Skip default processing for Attachment
    }


    // 🔹 Custom handling for comment list
    if (key === 'Comment' && Array.isArray(value.comments)) {
      result['Comments'] = value.comments.map(comment => {
        const author = comment.author?.displayName || '';
        const updateAuthor = comment.updateAuthor?.displayName || '';
        const created = comment.created;
        const updated = comment.updated;
        const text = extractTextFromAtlassianDoc(comment.body);

        return {
          author,
          text,
          'update author': updateAuthor,
          created,
          updated
        };
      });
      continue; // 🔸 Skip default handling
    }

    // 🔹 Handle primitive types
    if (typeof value === 'string' || typeof value === 'number') {
      result[key] = value;
    }

    // 🔹 Handle objects
    else if (value && typeof value === 'object') {
      if (value.hasOwnProperty('value') || value.hasOwnProperty('name') || value.hasOwnProperty('displayName')) {
        result[key] = value.value || value.name || value.displayName;
      } else if (value.type === 'doc') {
        result[key] = extractTextFromAtlassianDoc(value);
      } else if (Array.isArray(value)) {
        result[key] = value.map(item =>
          item?.value || item?.name || JSON.stringify(item)
        ).join(', ');
      } else if (value.displayName) {
        result[key] = value.displayName;
      } else {
        result[key] = JSON.stringify(value);
      }
    }
  }

  return result;
}


async function fetchAndSaveFields() {
  const fieldsUrl = `https://${domain}/rest/api/3/field`;
  try {
    const response = await fetch(fieldsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Accept": "application/json"
      }
    });

    const allFields = await response.json();
    return allFields;
  } catch (err) {
    console.error("❌ Error fetching fields:", err.message);
  }
}


async function fetchIssue(issueKey) {
  const url = `https://${domain}/rest/api/3/issue/${issueKey}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Accept": "application/json"
      }
    });

    console.log(`✅ Fetch Issue Response Status: ${response.status}`);
    const data = await response.json();
    return data;

  } catch (error) {
    console.error("❌ Failed to fetch issue:", error.message);
  }
}


async function generalCleaning(issueKey) {
  const allFields = await fetchAndSaveFields();
  const fetchedIssue = await fetchIssue(issueKey);
    // Clean null values
  const cleanIssue = {};
  dropNull(fetchedIssue, cleanIssue);

  if (fetchedIssue.fields) {
    cleanIssue.fields = {};
    dropNull(fetchedIssue.fields, cleanIssue.fields);
  }

  // Rename fields
  const fieldMap = {};
  allFields.forEach(field => {
    fieldMap[field.id] = field.name;
  });

  //console.log("fieldMap", fieldMap);

  const renamedFields = {};
  for (const key in cleanIssue.fields) {
    const readableKey = fieldMap[key] || key;
    renamedFields[readableKey] = cleanIssue.fields[key];
  }

  cleanIssue.fields = renamedFields;

  // Save to file
  //writeFileSync(`cleanIssue${issueKey}.json`, JSON.stringify(cleanIssue, null, 2));
  return cleanIssue;
} 

function dropFields(obj, keys) {
  const cleaned = {};

  for (const key in obj) {
    if (!keys.includes(key)) {
      cleaned[key] = obj[key];
    }
  }

  return cleaned;
}

async function finalObject(issue) {
  const cleanIssue = await generalCleaning(issue);
  const flattenedIssue = flattenFieldsMainIssue(cleanIssue.fields);
  flattenedIssue["key"] = cleanIssue["key"];
  const droppedFields = dropFields(flattenedIssue, keysToDrop);
  writeFileSync(`finalObj_${issue}.json`, JSON.stringify(droppedFields, null, 2));
  return droppedFields;
}

// FUNCTIONS FOR ATTACHMENTS
function isImage(filename) {
  return /\.(jpg|jpeg|png)$/i.test(filename);
}

// Utility: download image to temp file
async function downloadImage(url, filename) {
  const response = await axios.get(url, { responseType: 'arraybuffer' , headers: {Authorization: `Basic ${auth}`}});
  const tempPath = path.join('./temp', filename);

  await fsp.mkdir('./temp', { recursive: true });
  await fsp.writeFile(tempPath, response.data);

  return tempPath;
}

async function addAttachmentsToPDF(doc, attachments) {
  const imageFiles = attachments.filter(att => isImage(att.filename));
  const otherFiles = attachments.filter(att => !isImage(att.filename));

  // ➤ 1. Add image files, each on its own page
  for (let i = 0; i < imageFiles.length; i++) {
    const att = imageFiles[i];
    try {
      const localPath = await downloadImage(att.content, att.filename);

      doc.addPage(); // each image gets its own page

      if (i === 0) {
        doc.fillColor('black').fontSize(14).text('Attachments', { underline: true });
        doc.moveDown(2);
      }

      doc.fontSize(12).fillColor('black').text(`Filename: ${att.filename}`);
      doc.text(`Author: ${att.author}`);
      doc.text(`Created: ${formatDate(att.created)}`);
      doc.moveDown();

      doc.image(localPath, {
        fit: [500, 400],
        align: 'center',
        valign: 'center'
      });

      await fsp.unlink(localPath); // cleanup
    } catch (err) {
      console.error(`Failed to process ${att.filename}:`, err.message);
    }
  }

  // ➤ 2. Add other (non-image) attachments — all in one page
  if (otherFiles.length > 0) {
    doc.addPage(); // only one page for all non-image files

    doc.fontSize(16).fillColor('black').text('Other Attachments:', { underline: true });
    doc.moveDown();

    for (const att of otherFiles) {
      doc.fontSize(12).fillColor('black').text(`Filename: ${att.filename}`, { continued: true });
      doc.fillColor('blue').text(`  [Download]`, {
        link: att.content,
        underline: true
      });
      doc.fontSize(10).fillColor('gray').text(`Author: ${att.author} | Created: ${formatDate(att.created)}`);
      doc.moveDown(1.5); // extra space between entries
    }
  }
}



async function populateMainIssue(issue, doc) {
  const finalObj = issue;
  let cloneObj = { ...finalObj };
  const comments = cloneObj.Comments;
  const attachments = cloneObj.Attachments;
  const subtasks = cloneObj.Subtasks;
  delete cloneObj.Comments;
  delete cloneObj.Attachments;
  delete cloneObj.Subtasks;
  

  // Title
  doc.fontSize(16).text(`${cloneObj.Summary}`, { underline: true });
  doc.fontSize(14).text(`${cloneObj.key} - ${cloneObj.Project}`);
  delete cloneObj.key;
  delete cloneObj.Summary;

  doc.moveDown();

  // Show basic fields
  const basicFields = ['Issue Type', "ΑΚ", "Εταιρεία Ανάθεσης", "Building Id", "Status", "Resolution", "Assignee", "Διάρκεια", "Status", "Project", "Start Date", "End Date", "Priority"]
  doc.fillColor('black').fontSize(12).text('Issue Type: ', { continued: true });
  doc.fillColor('blue').text(cloneObj['Issue Type']);
  doc.fillColor('black').text('ΑΚ: ', { continued: true });
  doc.fillColor('blue').text(`${cloneObj["ΑΚ"]}     `, { continued: true });
  doc.fillColor('black').text('Εταιρεία Ανάθεσης: ', { continued: true });
  doc.fillColor('blue').text(cloneObj["Εταιρεία Ανάθεσης"]);
  doc.fillColor('black').text('BID: ', { continued: true });
  doc.fillColor('blue').text(cloneObj["Building Id"]);
  doc.fillColor('black').text('Status: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Status);
  doc.fillColor('black').text('Resolution: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Resolution);
  doc.fillColor('black').text('Assignee: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Assignee);
  doc.fillColor('black').text('Priority: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Priority);
  doc.fillColor('black').text('Created: ', { continued: true });
  doc.fillColor('blue').text(formatDate(cloneObj.Created));
  doc.fillColor('black').text('Start Date: ', { continued: true });
  doc.fillColor('blue').text(formatDate(cloneObj["Start Date"]));
  doc.fillColor('black').text('End Date: ', { continued: true });
  doc.fillColor('blue').text(formatDate(cloneObj["End Date"]));
  doc.fillColor('black').text('Διάρκεια: ', { continued: true });
  doc.fillColor('blue').text(cloneObj["Διάρκεια"]);
  doc.moveDown();
  basicFields.forEach(field => {
    delete cloneObj[field];
  })

  for (const key in cloneObj) {
    const value = cloneObj[key];

    // Check for empty string
    if (value === "") {
      doc.fillColor('black').text(`${key}: `, { continued: true });
      doc.fillColor('blue').text('null');
      continue;
    }

    // Check for date format
    if (typeof value === 'string' && dateRegex.test(value)) {
      const formatted = formatDate(value); // call the formatDate function we defined earlier
      doc.fillColor('black').text(`${key}: `, { continued: true });
      doc.fillColor('blue').text(formatted);
      continue;
    }

    // Default case
    doc.fillColor('black').text(`${key}: `, { continued: true });
    doc.fillColor('blue').text(value);
  }

  doc.moveDown(3);

  doc.fillColor('black').fontSize(14).text(`Comments`, { underline: true });
  doc.moveDown();

  //console.log(comments);

  comments.forEach(comm => {
    doc.fillColor('black').fontSize(10).text(`${comm.author}    `, { continued: true });
    doc.fillColor('black').text(formatDate(comm.created));
    doc.fillColor('black').fontSize(12).text(`Text: `, { continued: true });
    doc.fillColor('blue').text(comm.text);
    doc.fillColor('black').fontSize(10).text(`Update: `, { continued: true });
    doc.fillColor('black').text(`${comm["update author"]}    `, { continued: true });
    doc.fillColor('black').text(formatDate(comm.updated));
    doc.moveDown(2);
  });

  await addAttachmentsToPDF(doc, attachments);

  doc.addPage();
  doc.fillColor('black').fontSize(16).text(`Subtasks`, { underline: true });
  doc.moveDown(2);

  subtasks.forEach(sub => {
    doc.fillColor('blue').fontSize(12).text(`${sub.key}`, {
      underline: true
    });
    doc.fillColor('black').text(`${sub.summary}`);
    doc.fillColor('black').text(`Status: `, { continued: true });
    doc.fillColor('blue').text(`${sub.status}`);
    doc.fillColor('black').text(`Priority: `, { continued: true });
    doc.fillColor('blue').text(`${sub.priority}`);
    doc.fillColor('black').text(`Issue Type: `, { continued: true });
    doc.fillColor('blue').text(`${sub.issuetype}`);
    doc.moveDown();
  })


  

  console.log('PDF file created: jira-report.pdf');
}



async function testSubtaskFetch(mainIssue, issue, doc) {
  const subtask = await finalObject(issue);

  let cloneObj = { ...subtask };
  const comments = cloneObj.Comments;
  const attachments = cloneObj.Attachments;
  delete cloneObj.Comments;
  delete cloneObj.Attachments;
  
  doc.addPage();

  // Title
  doc.fontSize(14).fillColor('black').text(`${cloneObj.key}`);
  doc.fontSize(16).text(`${cloneObj.Summary}`, { underline: true });
  delete cloneObj.key;
  delete cloneObj.Summary;
  delete cloneObj.Parent;
  delete cloneObj.Subtasks;

  doc.moveDown(2);

  // Show basic fields
  const basicFields = ['Issue Type', "Status", "Resolution", "Assignee", "Διάρκεια", "Start Date", "End Date", "Priority"]

  doc.fillColor('black').fontSize(12).text('Issue Type: ', { continued: true });
  doc.fillColor('blue').text(cloneObj['Issue Type']);
  doc.fillColor('black').text('Status: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Status);
  doc.fillColor('black').text('Resolution: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Resolution);
  doc.fillColor('black').text('Assignee: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Assignee ? cloneObj.Assignee : 'null');
  doc.fillColor('black').text('Priority: ', { continued: true });
  doc.fillColor('blue').text(cloneObj.Priority);
  doc.fillColor('black').text('Created: ', { continued: true });
  doc.fillColor('blue').text(formatDate(cloneObj.Created));
  doc.fillColor('black').text('Start Date: ', { continued: true });
  doc.fillColor('blue').text(formatDate(cloneObj["Start Date"]));
  doc.fillColor('black').text('End Date: ', { continued: true });
  doc.fillColor('blue').text(formatDate(cloneObj["End Date"]));
  doc.fillColor('black').text('Διάρκεια: ', { continued: true });
  doc.fillColor('blue').text(cloneObj["Διάρκεια"]);
  doc.moveDown();
  basicFields.forEach(field => {
    delete cloneObj[field];
  })

  doc.moveDown(2);

  for (const key in cloneObj) {
    const value = cloneObj[key];

    // Check for empty string
    if (value === "") {
      doc.fillColor('black').text(`${key}: `, { continued: true });
      doc.fillColor('blue').text('null');
      continue;
    }

    // Check for date format
    if (typeof value === 'string' && dateRegex.test(value)) {
      const formatted = formatDate(value); // call the formatDate function we defined earlier
      doc.fillColor('black').text(`${key}: `, { continued: true });
      doc.fillColor('blue').text(formatted);
      continue;
    }

    // Default case
    doc.fillColor('black').text(`${key}: `, { continued: true });
    doc.fillColor('blue').text(value);
  }

  doc.moveDown(3);

  doc.fillColor('black').fontSize(14).text(`Comments`, { underline: true });
  doc.moveDown();

  comments.forEach(comm => {
    doc.fillColor('black').fontSize(10).text(`${comm.author}    `, { continued: true });
    doc.fillColor('black').text(formatDate(comm.created));
    doc.fillColor('black').fontSize(12).text(`Text: `, { continued: true });
    doc.fillColor('blue').text(comm.text);
    doc.fillColor('black').fontSize(10).text(`Update: `, { continued: true });
    doc.fillColor('black').text(`${comm["update author"]}    `, { continued: true });
    doc.fillColor('black').text(formatDate(comm.updated));
    doc.moveDown(2);
  });

  await addAttachmentsToPDF(doc, attachments);
}

export async function createPdf(issue) {
  const mainIssue = await finalObject(issue);
  const akValue = mainIssue['ΑΚ'] ? String(mainIssue['ΑΚ']) : 'Χωρίς ΑΚ';
  const companyValue = mainIssue['Εταιρεία Ανάθεσης'] ? String(mainIssue['Εταιρεία Ανάθεσης']) : 'Χωρίς Εταιρεία';

  
  const filename = `${mainIssue.key}.pdf`;
  const filePath = `./temp/${filename}`;

  const doc = new PDFDocument();
  doc.registerFont('Regular', './fonts/DejaVuSans.ttf');
  doc.font('Regular');

  await fs.promises.mkdir('./temp', { recursive: true });
  const writeStream = fs.createWriteStream(filePath);
  doc.pipe(writeStream);

  await populateMainIssue(mainIssue, doc);
  for (const sub of mainIssue.Subtasks) {
    await testSubtaskFetch(mainIssue, sub.key, doc);
  }

  doc.end();

    // Wait for the stream to finish writing
  await new Promise(resolve => writeStream.on('finish', resolve));

  // Step 3: Upload to Google Drive
  const driveLink = await uploadToDrive(filePath, filename, akValue, companyValue);
  console.log('✅ PDF uploaded to Google Drive:', driveLink);
}

//createPdf('FTT-7139');

