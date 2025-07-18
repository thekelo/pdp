// Set PDF.js worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';
const { jsPDF } = window.jspdf;

// DOM Elements (same as before)
const toolCards = document.querySelectorAll('.tool-card');
const fileInputs = document.querySelectorAll('.file-input');
const processingModal = document.getElementById('processing-modal');
const downloadModal = document.getElementById('download-modal');
const progressBar = document.getElementById('progress-bar');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const downloadTitle = document.getElementById('download-title');
const downloadMessage = document.getElementById('download-message');
const downloadBtn = document.getElementById('download-btn');
const cancelBtn = document.getElementById('cancel-btn');
const newFileBtn = document.getElementById('new-file-btn');

// Global variables
let currentTool = null;
let blob = null;
let processingInterval = null;
let abortController = new AbortController();

// Event listeners (same as before)
toolCards.forEach((card, index) => {
    const toolBtn = card.querySelector('.tool-btn');
    const fileInput = card.querySelector('.file-input');
    
    toolBtn.addEventListener('click', () => {
        currentTool = card.id;
        fileInput.click();
    });
});

fileInputs.forEach(input => {
    input.addEventListener('change', handleFileSelect);
});

cancelBtn.addEventListener('click', cancelProcessing);
newFileBtn.addEventListener('click', resetTool);
downloadBtn.addEventListener('click', downloadFile);

// File selection handler
async function handleFileSelect(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    // Check if merge tool and multiple files are selected
    if (currentTool === 'merge-pdf' && files.length < 2) {
        alert('Please select at least 2 PDF files to merge.');
        return;
    }
    
    showProcessingModal();
    abortController = new AbortController();
    
    try {
        // Actual processing based on tool
        switch(currentTool) {
            case 'pdf-to-word':
                blob = await convertPdfToWord(files[0]);
                break;
            case 'pdf-to-excel':
                blob = await convertPdfToExcel(files[0]);
                break;
            case 'pdf-to-jpg':
                blob = await convertPdfToImages(files[0], 'jpg');
                break;
            case 'pdf-to-png':
                blob = await convertPdfToImages(files[0], 'png');
                break;
            case 'pdf-to-text':
                blob = await extractPdfText(files[0]);
                break;
            case 'merge-pdf':
                blob = await mergePdfFiles(Array.from(files));
                break;
            case 'split-pdf':
                // For split, we'll handle differently as it produces multiple files
                await splitPdfFile(files[0]);
                return;
            case 'compress-pdf':
                blob = await compressPdfFile(files[0]);
                break;
        }
        
        processingComplete();
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Conversion error:', error);
            alert(`Conversion failed: ${error.message}`);
            cancelProcessing();
        }
    }
}

// ====================================
// ACTUAL CONVERSION IMPLEMENTATIONS
// ====================================

async function convertPdfToWord(pdfFile) {
    updateProgress(10, 'Loading PDF document...');
    const pdf = await pdfjsLib.getDocument(await readFileAsArrayBuffer(pdfFile)).promise;
    
    updateProgress(30, 'Extracting text content...');
    const { docx } = window.docx;
    const paragraphs = [];
    
    for (let i = 1; i <= pdf.numPages; i++) {
        if (abortController.signal.aborted) throw new Error('Conversion cancelled');
        
        updateProgress(30 + (i / pdf.numPages * 50), `Processing page ${i} of ${pdf.numPages}...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join(' ');
        
        paragraphs.push(
            new docx.Paragraph({
                children: [new docx.TextRun(text)],
                spacing: { after: 200 }
            })
        );
    }
    
    updateProgress(90, 'Generating Word document...');
    const doc = new docx.Document({
        sections: [{
            properties: {},
            children: paragraphs
        }]
    });
    
    const buffer = await docx.Packer.toBuffer(doc);
    return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

async function convertPdfToExcel(pdfFile) {
    updateProgress(10, 'Loading PDF document...');
    const pdf = await pdfjsLib.getDocument(await readFileAsArrayBuffer(pdfFile)).promise;
    
    updateProgress(30, 'Extracting tables...');
    const workbook = XLSX.utils.book_new();
    let worksheet;
    let tableData = [];
    
    for (let i = 1; i <= pdf.numPages; i++) {
        if (abortController.signal.aborted) throw new Error('Conversion cancelled');
        
        updateProgress(30 + (i / pdf.numPages * 50), `Processing page ${i} of ${pdf.numPages}...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        // Simple table extraction - this could be enhanced with more sophisticated parsing
        const lines = textContent.items.reduce((acc, item) => {
            const lineIndex = Math.floor(item.transform[5] / 20); // Simple line grouping
            acc[lineIndex] = (acc[lineIndex] || '') + item.str + '\t';
            return acc;
        }, {});
        
        const pageTables = Object.values(lines).map(line => line.split('\t').filter(cell => cell.trim()));
        tableData = tableData.concat(pageTables);
    }
    
    updateProgress(90, 'Generating Excel file...');
    worksheet = XLSX.utils.aoa_to_sheet(tableData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    
    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    return new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function convertPdfToImages(pdfFile, format) {
    updateProgress(10, 'Loading PDF document...');
    const pdf = await pdfjsLib.getDocument(await readFileAsArrayBuffer(pdfFile)).promise;
    
    updateProgress(20, 'Preparing images...');
    const zip = new JSZip();
    const imgFolder = zip.folder("images");
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const dpi = 150;
    
    for (let i = 1; i <= pdf.numPages; i++) {
        if (abortController.signal.aborted) throw new Error('Conversion cancelled');
        
        updateProgress(20 + (i / pdf.numPages * 70), `Converting page ${i} of ${pdf.numPages}...`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: dpi / 72 });
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        await page.render({
            canvasContext: ctx,
            viewport: viewport
        }).promise;
        
        const imageData = canvas.toDataURL(`image/${format}`);
        const base64Data = imageData.split(',')[1];
        imgFolder.file(`page_${i}.${format}`, base64Data, { base64: true });
    }
    
    updateProgress(95, 'Creating download package...');
    const content = await zip.generateAsync({ type: 'blob' });
    return content;
}

async function extractPdfText(pdfFile) {
    updateProgress(10, 'Loading PDF document...');
    const pdf = await pdfjsLib.getDocument(await readFileAsArrayBuffer(pdfFile)).promise;
    
    updateProgress(30, 'Extracting text...');
    let fullText = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
        if (abortController.signal.aborted) throw new Error('Conversion cancelled');
        
        updateProgress(30 + (i / pdf.numPages * 60), `Processing page ${i} of ${pdf.numPages}...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join(' ');
        fullText += `=== Page ${i} ===\n${text}\n\n`;
    }
    
    updateProgress(95, 'Preparing text file...');
    return new Blob([fullText], { type: 'text/plain' });
}

async function mergePdfFiles(pdfFiles) {
    updateProgress(5, 'Initializing merger...');
    const { PDFDocument } = PDFLib;
    const mergedPdf = await PDFDocument.create();
    
    for (let i = 0; i < pdfFiles.length; i++) {
        if (abortController.signal.aborted) throw new Error('Conversion cancelled');
        
        updateProgress(5 + (i / pdfFiles.length * 90), `Merging file ${i + 1} of ${pdfFiles.length}...`);
        const pdfBytes = await readFileAsArrayBuffer(pdfFiles[i]);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        
        const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
    }
    
    updateProgress(98, 'Finalizing merged document...');
    const mergedPdfBytes = await mergedPdf.save();
    return new Blob([mergedPdfBytes], { type: 'application/pdf' });
}

async function splitPdfFile(pdfFile) {
    updateProgress(10, 'Loading PDF document...');
    const { PDFDocument } = PDFLib;
    const pdfBytes = await readFileAsArrayBuffer(pdfFile);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();
    
    updateProgress(30, 'Creating individual pages...');
    const zip = new JSZip();
    
    for (let i = 0; i < pageCount; i++) {
        if (abortController.signal.aborted) throw new Error('Conversion cancelled');
        
        updateProgress(30 + (i / pageCount * 60), `Processing page ${i + 1} of ${pageCount}...`);
        const newPdf = await PDFDocument.create();
        const [page] = await newPdf.copyPages(pdfDoc, [i]);
        newPdf.addPage(page);
        
        const pageBytes = await newPdf.save();
        zip.file(`page_${i + 1}.pdf`, pageBytes);
    }
    
    updateProgress(95, 'Creating download package...');
    const content = await zip.generateAsync({ type: 'blob' });
    
    // For split PDF, we directly download the zip since it's multiple files
    processingModal.style.display = 'none';
    saveAs(content, 'split-pages.zip');
    resetFileInputs();
}

async function compressPdfFile(pdfFile) {
    updateProgress(10, 'Loading PDF document...');
    const { PDFDocument } = PDFLib;
    const pdfBytes = await readFileAsArrayBuffer(pdfFile);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    updateProgress(30, 'Optimizing PDF...');
    // Simple compression by reducing image quality
    const pages = pdfDoc.getPages();
    for (const page of pages) {
        const { node } = page;
        const contentStream = node.Contents();
        
        if (contentStream && contentStream.contents) {
            // This is a simplified approach - real compression would be more sophisticated
            const compressedContent = contentStream.contents.toString()
                .replace(/\/Quality \d+/g, '/Quality 50');
            contentStream.update(compressedContent);
        }
    }
    
    updateProgress(80, 'Saving compressed PDF...');
    const compressedBytes = await pdfDoc.save({
        useObjectStreams: true,
        // Additional compression options
        useCompression: true,
        // Reduce PDF version for better compression
        // (but may lose some features)
        // version: '1.5'
    });
    
    return new Blob([compressedBytes], { type: 'application/pdf' });
}

// ====================================
// HELPER FUNCTIONS
// ====================================

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function updateProgress(percent, message) {
    progressBar.style.width = `${percent}%`;
    if (message) modalMessage.textContent = message;
}

function showProcessingModal() {
    // Set modal content based on tool
    switch(currentTool) {
        case 'pdf-to-word':
            modalTitle.textContent = 'Converting PDF to Word';
            modalMessage.textContent = 'Converting your PDF to an editable Word document...';
            break;
        case 'pdf-to-excel':
            modalTitle.textContent = 'Converting PDF to Excel';
            modalMessage.textContent = 'Extracting tables from your PDF to Excel format...';
            break;
        case 'pdf-to-jpg':
            modalTitle.textContent = 'Converting PDF to JPG';
            modalMessage.textContent = 'Converting PDF pages to JPG images...';
            break;
        case 'pdf-to-png':
            modalTitle.textContent = 'Converting PDF to PNG';
            modalMessage.textContent = 'Converting PDF pages to PNG images...';
            break;
        case 'pdf-to-text':
            modalTitle.textContent = 'Extracting Text from PDF';
            modalMessage.textContent = 'Extracting text content from your PDF...';
            break;
        case 'merge-pdf':
            modalTitle.textContent = 'Merging PDF Files';
            modalMessage.textContent = 'Combining your PDF files into one document...';
            break;
        case 'split-pdf':
            modalTitle.textContent = 'Splitting PDF';
            modalMessage.textContent = 'Splitting your PDF into multiple files...';
            break;
        case 'compress-pdf':
            modalTitle.textContent = 'Compressing PDF';
            modalMessage.textContent = 'Reducing your PDF file size...';
            break;
    }
    
    processingModal.style.display = 'flex';
}

function processingComplete() {
    // Update download modal
    downloadTitle.textContent = 'Conversion Complete!';
    downloadMessage.textContent = `Your ${currentTool.replace(/-/g, ' ')} file is ready to download.`;
    
    let fileExtension = '';
    switch(currentTool) {
        case 'pdf-to-word': fileExtension = 'DOCX'; break;
        case 'pdf-to-excel': fileExtension = 'XLSX'; break;
        case 'pdf-to-jpg': fileExtension = 'JPG'; break;
        case 'pdf-to-png': fileExtension = 'PNG'; break;
        case 'pdf-to-text': fileExtension = 'TXT'; break;
        case 'merge-pdf': fileExtension = 'PDF'; break;
        case 'compress-pdf': fileExtension = 'PDF'; break;
    }
    
    downloadBtn.textContent = `Download ${fileExtension}`;
    
    // Show download modal
    processingModal.style.display = 'none';
    downloadModal.style.display = 'flex';
}

function cancelProcessing() {
    abortController.abort();
    processingModal.style.display = 'none';
    resetFileInputs();
}

function downloadFile() {
    if (!blob) return;
    
    let fileName = 'converted-file';
    switch(currentTool) {
        case 'pdf-to-word': fileName += '.docx'; break;
        case 'pdf-to-excel': fileName += '.xlsx'; break;
        case 'pdf-to-jpg': fileName += '.jpg'; break;
        case 'pdf-to-png': fileName += '.png'; break;
        case 'pdf-to-text': fileName += '.txt'; break;
        case 'merge-pdf': fileName = 'merged-document.pdf'; break;
        case 'compress-pdf': fileName = 'compressed.pdf'; break;
    }
    
    saveAs(blob, fileName);
}

function resetTool() {
    downloadModal.style.display = 'none';
    resetFileInputs();
}

function resetFileInputs() {
    fileInputs.forEach(input => {
        input.value = '';
    });
}
