import { XMLParser } from 'fast-xml-parser';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL = 'ctsurgerybriefing';

// One tailored search per literature category. Tune these terms over time —
// they're plain PubMed field-tagged queries, safe to edit without touching code.
export const CATEGORY_QUERIES = {
  coronary:
    '(coronary artery bypass[Title/Abstract] OR CABG[Title/Abstract] OR coronary revascularization[Title/Abstract] OR off-pump coronary[Title/Abstract])',
  valvular:
    '(aortic stenosis[Title/Abstract] OR mitral regurgitation[Title/Abstract] OR tricuspid regurgitation[Title/Abstract] OR valvular heart disease[Title/Abstract] OR mitral valve repair[Title/Abstract])',
  structural:
    '(TAVR[Title/Abstract] OR transcatheter aortic valve[Title/Abstract] OR transcatheter edge-to-edge repair[Title/Abstract] OR left atrial appendage occlusion[Title/Abstract] OR valve-in-valve[Title/Abstract])',
  aortic:
    '(aortic dissection[Title/Abstract] OR aortic aneurysm[Title/Abstract] OR aortic arch surgery[Title/Abstract] OR elephant trunk[Title/Abstract])',
  ecmo:
    '(ECMO[Title/Abstract] OR extracorporeal membrane oxygenation[Title/Abstract] OR mechanical circulatory support[Title/Abstract] OR ventricular assist device[Title/Abstract])',
  // eTOC-style sweep: no topic filter, just everything the major CT surgery
  // journals published in the window. Add or remove journals freely — a name
  // that doesn't match anything simply contributes zero results, it won't error.
  journals:
    '("Ann Thorac Surg"[Journal] OR "J Thorac Cardiovasc Surg"[Journal] OR "JTCVS Open"[Journal] OR "JTCVS Tech"[Journal] OR "Eur J Cardiothorac Surg"[Journal] OR "Interdiscip Cardiovasc Thorac Surg"[Journal] OR "Interact Cardiovasc Thorac Surg"[Journal] OR "Semin Thorac Cardiovasc Surg"[Journal] OR "Ann Cardiothorac Surg"[Journal] OR "J Card Surg"[Journal] OR "Ann Thorac Cardiovasc Surg"[Journal] OR "Innovations (Phila)"[Journal])',
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
