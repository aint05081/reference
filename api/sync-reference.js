const { Client } = require("@notionhq/client");
const crypto = require("crypto");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const REFERENCE_DB_ID = process.env.REFERENCE_DB_ID;

const CONTENT_STATUS_PROP = "제작 상태";
const CONTENT_BRAND_PROP = "브랜드";

const REF_TITLE_PROP = "이름";
const REF_RELATION_PROP = "🧸 광고 소재";
const REF_SELECT_PROP = "선택";
const REF_HASH_PROP = "Hash";

function pad(num) {
  return String(num).padStart(2, "0");
}

function getTitle(page) {
  const prop = Object.values(page.properties).find((p) => p.type === "title");
  return prop?.title?.[0]?.plain_text || "제목 없음";
}

function getBrandName(page) {
  const brand = page.properties[CONTENT_BRAND_PROP];

  if (!brand) return null;
  if (brand.type === "multi_select") return brand.multi_select?.[0]?.name || null;
  if (brand.type === "select") return brand.select?.name || null;

  return null;
}

async function findVideoBlocks(blockId, videos = []) {
  const children = await notion.blocks.children.list({
    block_id: blockId,
    page_size: 100,
  });

  for (const block of children.results) {
    if (block.type === "video") videos.push(block);

    if (block.has_children) {
      await findVideoBlocks(block.id, videos);
    }
  }

  return videos;
}

function getVideoUrl(block) {
  const video = block.video;
  if (!video) return null;

  if (video.type === "file" && video.file?.url) {
    return video.file.url;
  }

  if (video.type === "external" && video.external?.url) {
    return video.external.url;
  }

  return null;
}

async function downloadBuffer(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`다운로드 실패: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function findReferenceByHash(hash) {
  const result = await notion.dataSources.query({
    data_source_id: REFERENCE_DB_ID,
    filter: {
      property: REF_HASH_PROP,
      rich_text: {
        equals: hash,
      },
    },
  });

  return result.results[0] || null;
}

async function getNextReferenceNumber() {
  const result = await notion.dataSources.query({
    data_source_id: REFERENCE_DB_ID,
    page_size: 100,
  });

  let maxNumber = 0;

  for (const page of result.results) {
    const title =
      page.properties[REF_TITLE_PROP]?.title?.[0]?.plain_text || "";

    const num = parseInt(title, 10);

    if (!Number.isNaN(num)) {
      maxNumber = Math.max(maxNumber, num);
    }
  }

  return maxNumber + 1;
}

async function updateReferenceRelation(referencePage, contentPageId) {
  const current =
    referencePage.properties[REF_RELATION_PROP]?.relation?.map((r) => r.id) || [];

  if (current.includes(contentPageId)) return;

  await notion.pages.update({
    page_id: referencePage.id,
    properties: {
      [REF_RELATION_PROP]: {
        relation: [...current.map((id) => ({ id })), { id: contentPageId }],
      },
    },
  });
}

async function createFileUpload({ filename, contentType, buffer }) {
  const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "single_part",
      filename,
      content_type: contentType,
      content_length: buffer.length,
    }),
  });

  const upload = await createRes.json();

  if (!createRes.ok) {
    throw new Error(`파일 업로드 객체 생성 실패: ${JSON.stringify(upload)}`);
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), filename);

  const sendRes = await fetch(upload.upload_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
    },
    body: form,
  });

  const sent = await sendRes.json();

  if (!sendRes.ok) {
    throw new Error(`파일 전송 실패: ${JSON.stringify(sent)}`);
  }

  return upload.id;
}

async function createReferencePage({
  title,
  hash,
  brandName,
  contentPageId,
}) {
  const properties = {
    [REF_TITLE_PROP]: {
      title: [{ text: { content: title } }],
    },
    [REF_RELATION_PROP]: {
      relation: [{ id: contentPageId }],
    },
    [REF_HASH_PROP]: {
      rich_text: [{ text: { content: hash } }],
    },
  };

  if (brandName) {
    properties[REF_SELECT_PROP] = {
      select: { name: brandName },
    };
  }

  return notion.pages.create({
    parent: { data_source_id: REFERENCE_DB_ID },
    properties,
  });
}

async function appendVideoToReferencePage({ referencePageId, fileUploadId }) {
  await notion.blocks.children.append({
    block_id: referencePageId,
    children: [
      {
        object: "block",
        type: "video",
        video: {
          type: "file_upload",
          file_upload: {
            id: fileUploadId,
          },
        },
      },
    ],
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST만 가능" });
  }

  try {
    const pageId =
      req.body.pageId ||
      req.body.id ||
      req.body.page_id ||
      req.body.data?.id;

    if (!pageId) {
      return res.status(200).json({
        ok: false,
        error: "pageId 없음",
        receivedBody: req.body,
      });
    }

    const page = await notion.pages.retrieve({ page_id: pageId });
    const status = page.properties[CONTENT_STATUS_PROP]?.status?.name;

    if (status !== "레퍼런스 등록") {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: `현재 상태: ${status}`,
      });
    }

    const pageTitle = getTitle(page);
    const brandName = getBrandName(page);
    const videos = await findVideoBlocks(pageId);

    let created = 0;
    let linked = 0;
    let ignored = 0;
    let nextNumber = await getNextReferenceNumber();

    for (const videoBlock of videos) {
      const url = getVideoUrl(videoBlock);

      if (!url) {
        ignored++;
        continue;
      }

      const buffer = await downloadBuffer(url);
      const hash = sha256(buffer);

      const existing = await findReferenceByHash(hash);

      if (existing) {
        await updateReferenceRelation(existing, pageId);
        linked++;
        continue;
      }

      const title = pad(nextNumber);
      nextNumber++;

      const referencePage = await createReferencePage({
        title,
        hash,
        brandName,
        contentPageId: pageId,
      });

      const fileUploadId = await createFileUpload({
        filename: `${title}.mp4`,
        contentType: "video/mp4",
        buffer,
      });

      await appendVideoToReferencePage({
        referencePageId: referencePage.id,
        fileUploadId,
      });

      created++;
    }

    return res.status(200).json({
      ok: true,
      pageTitle,
      brandName,
      totalVideos: videos.length,
      created,
      linked,
      ignored,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};