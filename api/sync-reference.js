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
const REF_TYPE_PROP = "종류";
const REF_POSTED_DATE_PROP = "게시 일자";
const REF_SELECTED_DATE_PROP = "선정 일자";

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

function isVideoFileName(name = "") {
  const lower = name.toLowerCase();
  return lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm");
}

function isImageFileName(name = "") {
  const lower = name.toLowerCase();
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".webp") || lower.endsWith(".gif");
}

function getPlainText(block) {
  const type = block.type;
  const richText = block[type]?.rich_text || [];
  return richText.map((t) => t.plain_text).join("");
}

function parseDates(text) {
  const postedMatch = text.match(/게시\s*일자\s*:\s*(\d{4}-\d{2}-\d{2})/);
  const selectedMatch = text.match(/선정\s*일자\s*:\s*(\d{4}-\d{2}-\d{2})/);

  return {
    postedDate: postedMatch?.[1] || null,
    selectedDate: selectedMatch?.[1] || null,
  };
}

async function getChildren(blockId) {
  const results = [];
  let cursor;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });

    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function findMediaBlocks(blockId, mediaBlocks = []) {
  const children = await getChildren(blockId);

  for (let i = 0; i < children.length; i++) {
    const block = children[i];
    const nextBlock = children[i + 1];

    let kind = null;

    if (block.type === "video") {
      kind = "video";
    }

    if (block.type === "image") {
      kind = "image";
    }

    if (block.type === "file") {
      const fileName = block.file?.name || "";

      if (isVideoFileName(fileName)) kind = "video-file";
      if (isImageFileName(fileName)) kind = "image-file";
    }

    if (kind) {
      const nextText =
        nextBlock && nextBlock.type === "paragraph"
          ? getPlainText(nextBlock)
          : "";

      const dates = parseDates(nextText);

      mediaBlocks.push({
        block,
        kind,
        postedDate: dates.postedDate,
        selectedDate: dates.selectedDate,
      });
    }

    if (block.has_children) {
      await findMediaBlocks(block.id, mediaBlocks);
    }
  }

  return mediaBlocks;
}

function getMediaUrl(media) {
  const { block } = media;

  if (block.type === "video") {
    const video = block.video;

    if (video?.type === "file" && video.file?.url) return video.file.url;
    if (video?.type === "external" && video.external?.url) return video.external.url;
  }

  if (block.type === "image") {
    const image = block.image;

    if (image?.type === "file" && image.file?.url) return image.file.url;
    if (image?.type === "external" && image.external?.url) return image.external.url;
  }

  if (block.type === "file") {
    const file = block.file;

    if (file?.type === "file" && file.file?.url) return file.file.url;
    if (file?.type === "external" && file.external?.url) return file.external.url;
  }

  return null;
}

function getContentType(media) {
  if (media.kind.includes("image")) return "image/png";
  return "video/mp4";
}

function getExtension(media) {
  if (media.kind.includes("image")) return "png";
  return "mp4";
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
    const title = page.properties[REF_TITLE_PROP]?.title?.[0]?.plain_text || "";
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
  postedDate,
  selectedDate,
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
    [REF_TYPE_PROP]: {
      select: { name: "레퍼런스" },
    },
  };

  if (brandName) {
    properties[REF_SELECT_PROP] = {
      select: { name: brandName },
    };
  }

  if (postedDate) {
    properties[REF_POSTED_DATE_PROP] = {
      date: { start: postedDate },
    };
  }

  if (selectedDate) {
    properties[REF_SELECTED_DATE_PROP] = {
      date: { start: selectedDate },
    };
  }

  return notion.pages.create({
    parent: { data_source_id: REFERENCE_DB_ID },
    properties,
  });
}

async function appendMediaToReferencePage({ referencePageId, fileUploadId, kind }) {
  const isImage = kind.includes("image");

  await notion.blocks.children.append({
    block_id: referencePageId,
    children: [
      isImage
        ? {
            object: "block",
            type: "image",
            image: {
              type: "file_upload",
              file_upload: { id: fileUploadId },
            },
          }
        : {
            object: "block",
            type: "video",
            video: {
              type: "file_upload",
              file_upload: { id: fileUploadId },
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
      const result = {
        ok: true,
        skipped: true,
        reason: `현재 상태: ${status}`,
      };

      console.log("RESULT:", result);
      return res.status(200).json(result);
    }

    const pageTitle = getTitle(page);
    const brandName = getBrandName(page);
    const mediaBlocks = await findMediaBlocks(pageId);

    let created = 0;
    let linked = 0;
    let ignored = 0;
    let nextNumber = await getNextReferenceNumber();

    for (const media of mediaBlocks) {
      const url = getMediaUrl(media);

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
        postedDate: media.postedDate,
        selectedDate: media.selectedDate,
      });

      const extension = getExtension(media);
      const contentType = getContentType(media);

      const fileUploadId = await createFileUpload({
        filename: `${title}.${extension}`,
        contentType,
        buffer,
      });

      await appendMediaToReferencePage({
        referencePageId: referencePage.id,
        fileUploadId,
        kind: media.kind,
      });

      created++;
    }

    const result = {
      ok: true,
      pageTitle,
      brandName,
      totalMediaBlocks: mediaBlocks.length,
      created,
      linked,
      ignored,
    };

    console.log("RESULT:", result);
    return res.status(200).json(result);
  } catch (error) {
    console.error("ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};