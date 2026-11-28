import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { RecapRow, SessionReviewPayload } from '../types';

export const SCHOOL_NAME = 'MTs Nurul Islam Gunung Sari';

export function formatExamDateIndo(raw?: string | null): string {
  if (!raw || !raw.trim()) return '-';
  const trimmed = raw.trim();
  const parsed = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  return parsed.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'dokumen'
  );
}

export function downloadStudentAnswerSheetPdf(review: SessionReviewPayload): void {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;

  // School Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(SCHOOL_NAME.toUpperCase(), margin, 16);

  doc.setFontSize(10);
  doc.setTextColor(29, 78, 216);
  doc.text('LEMBAR JAWABAN PESERTA UJIAN', margin, 21.5);

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.4);
  doc.line(margin, 24, pageWidth - margin, 24);

  // Two-column metadata block
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);

  const leftColX = margin;
  const rightColX = margin + contentWidth * 0.52;
  const labelW = 28;

  const leftRows: Array<[string, string]> = [
    ['Nama Siswa', review.student.name],
    ['NIS', review.student.nis],
    ['Kelas', review.student.className || review.package.className],
    ['Judul Ujian', review.package.title],
  ];

  const rightRows: Array<[string, string]> = [
    ['Mata Pelajaran', review.package.subjectName],
    ['Guru Mapel', review.package.teacherName || '-'],
    ['Guru Pengawas', review.package.proctorName || 'Belum ditugaskan'],
    ['Tanggal Ujian', formatExamDateIndo(review.package.examDate)],
  ];

  let y = 30;
  for (let i = 0; i < leftRows.length; i++) {
    const [lLabel, lVal] = leftRows[i];
    const [rLabel, rVal] = rightRows[i];

    doc.setFont('helvetica', 'bold');
    doc.text(lLabel, leftColX, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`: ${lVal}`, leftColX + labelW, y, { maxWidth: contentWidth * 0.48 - labelW });

    doc.setFont('helvetica', 'bold');
    doc.text(rLabel, rightColX, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`: ${rVal}`, rightColX + labelW, y, { maxWidth: contentWidth * 0.48 - labelW });

    y += 5.5;
  }

  // Summary score bar
  y += 2;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(margin, y, contentWidth, 13, 2, 2, 'FD');

  const kkmValue = review.package.kkm ?? 75;
  const scoreDisplay = review.session.score !== null ? String(review.session.score) : '-';
  const correctDisplay = `${review.session.correctCount ?? 0} / ${review.session.totalQuestions}`;
  const statusDisplay =
    review.session.status === 'SUBMITTED'
      ? review.session.score !== null && review.session.score >= kkmValue
        ? `Selesai (Tuntas >= ${kkmValue})`
        : `Selesai (Remedial < ${kkmValue})`
      : review.session.status;

  const boxWidth = contentWidth / 4;
  const stats: Array<[string, string]> = [
    ['Nilai Akhir', scoreDisplay],
    ['Jawaban Benar', correctDisplay],
    ['Status / Ketuntasan', statusDisplay],
    ['Pelanggaran', `${review.session.violationCount}x`],
  ];

  stats.forEach(([label, val], idx) => {
    const bx = margin + idx * boxWidth + 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(label, bx, y + 4.8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(val, bx, y + 10);
  });

  y += 17;

  // Answer table
  const tableRows = review.items.map((item) => {
    const optionsLines = item.options.map((opt) => {
      const marker =
        opt.key === item.correctOption
          ? ' [Kunci]'
          : opt.key === item.selectedOption
            ? ' [Dipilih]'
            : '';
      return `${opt.key}. ${opt.text}${marker}`;
    });
    const questionCell = `${item.questionText}\n${optionsLines.join('\n')}`;
    const selectedCell = item.selectedOption || '-';
    const resultCell = item.isCorrect
      ? `Benar (+${item.points})`
      : item.selectedOption
        ? 'Salah (0)'
        : 'Kosong (0)';

    return [
      String(item.number),
      questionCell,
      selectedCell,
      item.correctOption,
      resultCell,
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['No', 'Pertanyaan & Pilihan Jawaban', 'Jawab', 'Kunci', 'Hasil']],
    body: tableRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
      valign: 'top',
    },
    headStyles: {
      fillColor: [241, 245, 249],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
      fontSize: 8,
    },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 14, halign: 'center', fontStyle: 'bold' },
      3: { cellWidth: 14, halign: 'center', fontStyle: 'bold' },
      4: { cellWidth: 23, halign: 'center' },
    },
    didParseCell(hookData) {
      if (hookData.section === 'body' && hookData.column.index === 4) {
        const text = String(hookData.cell.raw || '');
        if (text.startsWith('Benar')) {
          hookData.cell.styles.textColor = [4, 120, 87];
          hookData.cell.styles.fontStyle = 'bold';
        } else if (text.startsWith('Salah')) {
          hookData.cell.styles.textColor = [185, 28, 28];
        } else {
          hookData.cell.styles.textColor = [100, 116, 139];
        }
      }
    },
  });

  const filename = `lembar-jawaban-${slugify(review.student.nis)}-${slugify(review.student.name)}.pdf`;
  doc.save(filename);
}

export interface RecapPdfParams {
  pkgInfo: {
    title: string;
    subjectName: string;
    className: string;
    teacherName?: string;
    proctorName?: string | null;
    examDate?: string;
  };
  kkm: number;
  summary: {
    totalParticipants: number;
    submittedCount: number;
    avgScore: string;
    maxScore: string;
    minScore: string;
    passedCount: number;
    passRate: number;
    remedialCount: number;
  };
  records: RecapRow[];
}

export function downloadRecapReportPdf(params: RecapPdfParams): void {
  const { pkgInfo, kkm, summary, records } = params;
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;

  // 1. Header MTs Nurul Islam Gunung Sari
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(SCHOOL_NAME.toUpperCase(), margin, 16);

  doc.setFontSize(10);
  doc.setTextColor(29, 78, 216);
  doc.text(`REKAPITULASI NILAI UJIAN — ${pkgInfo.title}`, margin, 21.5);

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.4);
  doc.line(margin, 24, pageWidth - margin, 24);

  // Header metadata fields
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  const leftColX = margin;
  const rightColX = margin + contentWidth * 0.52;
  const labelW = 28;

  const leftMeta: Array<[string, string]> = [
    ['Kelas', pkgInfo.className],
    ['Mata Pelajaran', pkgInfo.subjectName],
    ['Guru Mapel', pkgInfo.teacherName || '-'],
  ];

  const rightMeta: Array<[string, string]> = [
    ['Guru Pengawas', pkgInfo.proctorName || 'Belum ditugaskan'],
    ['Tanggal Ujian', formatExamDateIndo(pkgInfo.examDate)],
    ['KKM', String(kkm)],
  ];

  let y = 30;
  for (let i = 0; i < leftMeta.length; i++) {
    const [lLabel, lVal] = leftMeta[i];
    const [rLabel, rVal] = rightMeta[i];

    doc.setFont('helvetica', 'bold');
    doc.text(lLabel, leftColX, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`: ${lVal}`, leftColX + labelW, y, { maxWidth: contentWidth * 0.48 - labelW });

    doc.setFont('helvetica', 'bold');
    doc.text(rLabel, rightColX, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`: ${rVal}`, rightColX + labelW, y, { maxWidth: contentWidth * 0.48 - labelW });

    y += 5.5;
  }

  // 2. 4 Summary Cards before table (Peserta -> Rata-rata -> Tuntas -> Remedial)
  y += 2;
  const cardGap = 3;
  const cardWidth = (contentWidth - cardGap * 3) / 4;
  const cardHeight = 16;

  const cards: Array<{ title: string; value: string; sub: string; accent: [number, number, number] }> = [
    {
      title: 'Peserta Selesai',
      value: `${summary.submittedCount} / ${summary.totalParticipants}`,
      sub: `Kelas ${pkgInfo.className}`,
      accent: [15, 23, 42],
    },
    {
      title: 'Rata-rata Nilai',
      value: summary.avgScore,
      sub: `Max ${summary.maxScore} · Min ${summary.minScore}`,
      accent: [15, 23, 42],
    },
    {
      title: `Tuntas (>= ${kkm})`,
      value: `${summary.passedCount} (${summary.passRate}%)`,
      sub: 'Memenuhi KKM',
      accent: [4, 120, 87],
    },
    {
      title: `Remedial (< ${kkm})`,
      value: String(summary.remedialCount),
      sub: 'Perlu pendampingan',
      accent: [180, 83, 9],
    },
  ];

  cards.forEach((card, idx) => {
    const cx = margin + idx * (cardWidth + cardGap);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(203, 213, 225);
    doc.roundedRect(cx, y, cardWidth, cardHeight, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(card.title, cx + 2.5, y + 4.8);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...card.accent);
    doc.text(card.value, cx + 2.5, y + 10.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(card.sub, cx + 2.5, y + 14.3);
  });

  y += cardHeight + 5;

  // 3. Sort descending from highest score
  const sortedRecords = [...records].sort((a, b) => {
    const sa = a.status === 'SUBMITTED' && a.score !== null ? Number(a.score) : -1;
    const sb = b.status === 'SUBMITTED' && b.score !== null ? Number(b.score) : -1;
    return sb - sa || a.name.localeCompare(b.name);
  });

  const bodyRows = sortedRecords.map((r, idx) => {
    const isSubmitted = r.status === 'SUBMITTED' && r.score !== null;
    const isPassed = isSubmitted && Number(r.score) >= kkm;
    const statusText =
      r.status === 'SUBMITTED'
        ? 'Selesai'
        : r.status === 'IN_PROGRESS'
          ? 'Mengerjakan'
          : r.status === 'LOCKED_VIOLATION'
            ? 'Terkunci'
            : 'Belum Mulai';

    return [
      String(idx + 1),
      r.nis,
      r.name,
      isSubmitted ? `${r.correct_count ?? 0}/${r.total_questions}` : `-/${r.total_questions}`,
      isSubmitted ? String(r.score) : '-',
      isSubmitted ? (isPassed ? 'Tuntas' : 'Remedial') : '-',
      statusText,
      `${r.violation_count}x`,
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['No', 'NIS', 'Nama Siswa', 'Benar', 'Nilai', 'Ketuntasan', 'Status', 'Pelangg.']],
    body: bodyRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: 2.2,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [241, 245, 249],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
      fontSize: 8,
    },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 24 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 17, halign: 'center' },
      4: { cellWidth: 16, halign: 'center', fontStyle: 'bold' },
      5: { cellWidth: 21, halign: 'center' },
      6: { cellWidth: 22, halign: 'center' },
      7: { cellWidth: 17, halign: 'right' },
    },
    didParseCell(hookData) {
      if (hookData.section === 'body' && hookData.column.index === 5) {
        const val = String(hookData.cell.raw || '');
        if (val === 'Tuntas') {
          hookData.cell.styles.textColor = [4, 120, 87];
          hookData.cell.styles.fontStyle = 'bold';
        } else if (val === 'Remedial') {
          hookData.cell.styles.textColor = [180, 83, 9];
          hookData.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });

  const filename = `rekap-nilai-${slugify(pkgInfo.subjectName)}-${slugify(pkgInfo.className)}.pdf`;
  doc.save(filename);
}
