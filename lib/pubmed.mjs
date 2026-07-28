import { XMLParser } from 'fast-xml-parser';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL = 'ctsurgerybriefing';

// One tailored search per literature category. Tune these terms over time —
// they're plain PubMed field-tagged queries, safe to edit without touching code.

export const CATEGORY_QUERIES = {
  coronary:
    '(coronary artery bypass[Title/Abstract] OR CABG[Title/Abstract] OR coronary revascularization[Title/Abstract] OR off-pump coronary[Title/Abstract] OR hybrid coronary revascularization[Title/Abstract] OR internal mammary artery[Title/Abstract] OR MIDCAB[Title/Abstract] OR robotic CABG[Title/Abstract])',
  valvular:
    '(aortic stenosis[Title/Abstract] OR aortic regurgitation[Title/Abstract] OR mitral regurgitation[Title/Abstract] OR mitral stenosis[Title/Abstract] OR tricuspid regurgitation[Title/Abstract] OR tricuspid stenosis[Title/Abstract] OR valvular heart disease[Title/Abstract] OR mitral valve repair[Title/Abstract] OR bicuspid aortic valve[Title/Abstract] OR structural valve deterioration[Title/Abstract])',
  structural:
    '(TAVR[Title/Abstract] OR transcatheter aortic valve[Title/Abstract] OR transcatheter edge-to-edge repair[Title/Abstract] OR TEER[Title/Abstract] OR M-TEER[Title/Abstract] OR T-TEER[Title/Abstract] OR mitral TEER[Title/Abstract] OR tricuspid TEER[Title/Abstract] OR MitraClip[Title/Abstract] OR TriClip[Title/Abstract] OR leaflet modification[Title/Abstract] OR LAMPOON[Title/Abstract] OR left atrial appendage occlusion[Title/Abstract] OR Watchman[Title/Abstract] OR valve-in-valve[Title/Abstract] OR transcatheter mitral valve[Title/Abstract] OR transcatheter tricuspid valve[Title/Abstract] OR transcatheter pulmonary valve[Title/Abstract] OR PFO closure[Title/Abstract] OR patent foramen ovale[Title/Abstract] OR paravalvular leak[Title/Abstract])',
  aortic:
    '(aortic dissection[Title/Abstract] OR type A dissection[Title/Abstract] OR type B dissection[Title/Abstract] OR aortic aneurysm[Title/Abstract] OR aortic arch surgery[Title/Abstract] OR elephant trunk[Title/Abstract] OR frozen elephant trunk[Title/Abstract] OR hemiarch[Title/Abstract] OR aortic root replacement[Title/Abstract] OR Bentall[Title/Abstract] OR TEVAR[Title/Abstract] OR endovascular aortic repair[Title/Abstract])',
  mcs:
    '(ECMO[Title/Abstract] OR extracorporeal membrane oxygenation[Title/Abstract] OR VA-ECMO[Title/Abstract] OR venoarterial ECMO[Title/Abstract] OR mechanical circulatory support[Title/Abstract] OR temporary mechanical circulatory support[Title/Abstract] OR ventricular assist device[Title/Abstract] OR LVAD[Title/Abstract] OR HeartMate[Title/Abstract] OR Impella[Title/Abstract] OR TandemHeart[Title/Abstract] OR intra-aortic balloon pump[Title/Abstract] OR cardiogenic shock[Title/Abstract] OR bridge to transplant[Title/Abstract])',
  journals:
  '("Ann Thorac Surg"[Journal] OR "J Thorac Cardiovasc Surg"[Journal] OR "JTCVS Open"[Journal] OR "JTCVS Tech"[Journal] OR "Eur J Cardiothorac Surg"[Journal] OR "Interdiscip Cardiovasc Thorac Surg"[Journal] OR "Interact Cardiovasc Thorac Surg"[Journal] OR "Semin Thorac Cardiovasc Surg"[Journal] OR "Ann Cardiothorac Surg"[Journal] OR "J Card Surg"[Journal] OR "Ann Thorac Cardiovasc Surg"[Journal] OR "Innovations (Phila)"[Journal]) NOT (congenital[Title/Abstract] OR pediatric[Title/Abstract] OR infant[Title/Abstract] OR neonat*[Title/Abstract] OR lung cancer[Title/Abstract] OR lung transplant[Title/Abstract] OR lobectomy[Title/Abstract] OR pneumonectomy[Title/Abstract] OR pulmonary resection[Title/Abstract] OR esophageal[Title/Abstract] OR esophagectomy[Title/Abstract] OR mediastinal[Title/Abstract] OR mediastinum[Title/Abstract] OR pleural[Title/Abstract] OR thymoma[Title/Abstract] OR thymectomy[Title/Abstract] OR tracheal[Title/Abstract])',
};

function eutilsParams(extra) {
  const p = new URLSearchParams(extra);
  p.set('tool', TOOL);
  if (process.env.PUBMED_EMAIL) p.set('email', process.env.PUBMED_EMAIL);
  if (process.env.PUBMED_API_KEY) p.set('api_key', process.env.PUBMED_API_KEY);
  return p.toString();
}

// Returns an array of { pmid, title, journal, abstract, publishedDate, url }
// for the newest matching articles, filtered to the last `days` days.
export async function searchPubmed(query, { days = 3, retmax = 10 } = {}) {
  const searchUrl = `${BASE}/esearch.fcgi?${eutilsParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: String(retmax),
    sort: 'date',
    datetype: 'pdat',
    reldate: String(days),
  })}`;

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`esearch failed: ${searchRes.status}`);
  const searchJson = await searchRes.json();
  const ids = searchJson?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const fetchUrl = `${BASE}/efetch.fcgi?${eutilsParams({
    db: 'pubmed',
    id: ids.join(','),
    rettype: 'abstract',
    retmode: 'xml',
  })}`;

  const fetchRes = await fetch(fetchUrl);
  if (!fetchRes.ok) throw new Error(`efetch failed: ${fetchRes.status}`);
  const xml = await fetchRes.text();

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);

  let articles = parsed?.PubmedArticleSet?.PubmedArticle ?? [];
  if (!Array.isArray(articles)) articles = [articles];

  return articles
    .map((entry) => parseArticle(entry))
    .filter(Boolean);
}

function parseArticle(entry) {
  try {
    const medline = entry.MedlineCitation;
    const pmid = String(medline?.PMID?.['#text'] ?? medline?.PMID ?? '').trim();
    const article = medline?.Article;
    if (!pmid || !article) return null;

    const title = flattenText(article.ArticleTitle);

    let abstractText = '';
    const abstractNode = article?.Abstract?.AbstractText;
    if (Array.isArray(abstractNode)) {
      abstractText = abstractNode.map(flattenText).join(' ');
    } else if (abstractNode) {
      abstractText = flattenText(abstractNode);
    }
    if (!abstractText) return null; // skip anything without a real abstract

    const journal = flattenText(article?.Journal?.Title) || 'PubMed';
    const authors = extractAuthors(article);

    const pubDate = article?.Journal?.JournalIssue?.PubDate;
    const publishedDate = formatPubDate(pubDate);

    return {
      pmid,
      title,
      journal,
      authors,
      abstract: abstractText,
      publishedDate,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    };
  } catch {
    return null;
  }
}

// Formats as "Smith J, Lee K, Patel R, et al." (first 3, then et al. if more).
function extractAuthors(article) {
  const authorList = article?.AuthorList?.Author;
  if (!authorList) return null;
  const authors = Array.isArray(authorList) ? authorList : [authorList];
  const names = authors
    .map((a) => {
      if (a.CollectiveName) return flattenText(a.CollectiveName);
      const last = flattenText(a.LastName);
      const initials = flattenText(a.Initials);
      if (!last) return null;
      return initials ? `${last} ${initials}` : last;
    })
    .filter(Boolean);
  if (names.length === 0) return null;
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')}, et al.`;
}

function flattenText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    if ('#text' in node) return String(node['#text']);
    return Object.values(node).map(flattenText).join(' ');
  }
  return String(node);
}

function formatPubDate(pubDate) {
  if (!pubDate) return null;
  const year = pubDate.Year;
  const monthRaw = pubDate.Month || '01';
  const day = pubDate.Day || '01';
  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const month = monthMap[monthRaw] || (String(monthRaw).padStart(2, '0'));
  if (!year) return null;
  return `${year}-${month}-${String(day).padStart(2, '0')}`;
}
