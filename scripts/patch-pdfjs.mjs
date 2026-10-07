/**
 * Applies the df patches to the vendored pdf.js distribution.
 *
 * pdf.js 6.x has no concept of an annotation *author*, cannot create sticky
 * notes (`/Subtype /Text`), cannot write reply threads (`/IRT`), and its
 * comment sidebar shows no author name. The patches below add exactly that,
 * Adobe-Reader style, while staying PDF-spec compatible (standard `/T`,
 * `/Contents`, `/Popup`, `/Subtype /Text`, `/IRT` + `/RT /R`), so the saved
 * files remain fully readable/editable in Acrobat and other viewers.
 *
 * Run via `make pdfjs` (the download script calls it) or `node scripts/patch-pdfjs.mjs`.
 * Safe to run repeatedly; `--check` only verifies the patches are present.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dirname);
const checkOnly = process.argv.includes("--check");

/** @type {{file: string, marker: string, find: string, replace: string}[]} */
const PATCHES = [
  // --- build/pdf.mjs ---------------------------------------------------------
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "user: this.user ?? (this.annotationElementId",
    note: "serialize(): emit `user` so the worker writes the /T author field",
    find: `  serialize(isForCopying = false, context = null) {
    return {
      annotationType: this.mode,
      pageIndex: this.pageIndex,
      rect: this.getPDFRect(),
      rotation: this.rotation,
      structTreeParentId: this._structTreeParentId,
      popupRef: this._initialData?.popupRef || ""
    };
  }`,
    replace: `  serialize(isForCopying = false, context = null) {
    return {
      annotationType: this.mode,
      pageIndex: this.pageIndex,
      rect: this.getPDFRect(),
      rotation: this.rotation,
      structTreeParentId: this._structTreeParentId,
      popupRef: this._initialData?.popupRef || "",
      dfId: this.id,
      user: this.user ?? (this.annotationElementId ? null : this._uiManager?.dfDefaultAuthor) ?? null
    };
  }`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "user: this.user || this._initialData?.user",
    note: "getData(): expose the author to the comments sidebar",
    find: `      creationDate,
      modificationDate: date || modificationDate,
      popupRef: !deleted,
      color,
      opacity
    };
  }`,
    replace: `      creationDate,
      modificationDate: date || modificationDate,
      popupRef: !deleted,
      color,
      opacity,
      user: this.user || this._initialData?.user || this._uiManager?.dfDefaultAuthor || null
    };
  }`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "async dfShowComments()",
    note: "updateMode(): delegate comment collection to dfShowComments (includes sticky notes, replies and df storage entries)",
    find: `    if (mode === AnnotationEditorType.POPUP) {
      this.#allEditableAnnotations ||= await this.#pdfDocument.getAnnotationsByType(new Set(this.#editorTypes.map(editorClass => editorClass._editorType)));
      const elementIds = new Set();
      const allComments = [];
      for (const editor of this.#allEditors.values()) {
        const {
          annotationElementId,
          hasComment,
          deleted
        } = editor;
        if (annotationElementId) {
          elementIds.add(annotationElementId);
        }
        if (hasComment && !deleted) {
          allComments.push(editor.getData());
        }
      }
      for (const annotation of this.#allEditableAnnotations) {
        const {
          id,
          popupRef,
          contentsObj
        } = annotation;
        if (popupRef && contentsObj?.str && !elementIds.has(id) && !this.#deletedAnnotationsElementIds.has(id)) {
          allComments.push(annotation);
        }
      }
      this.#commentManager?.showSidebar(allComments);
    }`,
    replace: `    if (mode === AnnotationEditorType.POPUP) {
      await this.dfShowComments();
    }`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "async dfShowComments() {",
    note: "add dfShowComments(): collect comments incl. sticky notes, replies and unsaved df entries",
    find: `  addNewEditorFromKeyboard() {`,
    replace: `  async dfShowComments() {
    if (!this.#commentManager) {
      return;
    }
    // #editorTypes is null until an edit tool is first activated; guard the map.
    this.#allEditableAnnotations ||= await this.#pdfDocument.getAnnotationsByType(new Set([...(this.#editorTypes ?? []).map(editorClass => editorClass._editorType), AnnotationType.TEXT]));
    const elementIds = new Set();
    const editedIds = new Set();
    for (const [, value] of this.#annotationStorage) {
      if (value?.dfComment === true && value.id) {
        editedIds.add(value.id);
      }
    }
    const allComments = [];
    for (const editor of this.#allEditors.values()) {
      const {
        annotationElementId,
        hasComment,
        deleted
      } = editor;
      if (annotationElementId) {
        elementIds.add(annotationElementId);
      }
      if (hasComment && !deleted) {
        allComments.push(editor.getData());
      }
    }
    for (const annotation of this.#allEditableAnnotations) {
      const {
        id,
        popupRef,
        contentsObj,
        annotationType
      } = annotation;
      const isNote = annotationType === AnnotationType.TEXT;
      if ((isNote || popupRef) && contentsObj?.str && !elementIds.has(id) && !editedIds.has(id) && !this.#deletedAnnotationsElementIds.has(id)) {
        annotation.user ||= annotation.titleObj?.str || this.dfDefaultAuthor || null;
        if (isNote) {
          annotation.dfComment = true;
        }
        allComments.push(annotation);
      }
    }
    for (const [, value] of this.#annotationStorage) {
      if (value instanceof AnnotationEditor || value?.dfComment !== true || value.deleted) {
        continue;
      }
      value.user ||= this.dfDefaultAuthor || null;
      value.contentsObj ||= { str: value.contents || "" };
      allComments.push(value);
    }
    for (const comment of allComments) {
      const stateName = typeof comment.state === "string" ? comment.state : comment.state?.name;
      const modelName = typeof comment.stateModel === "string" ? comment.stateModel : comment.stateModel?.name;
      comment.dfResolved ||= comment.resolved === true || (stateName === "Closed" && (modelName || "Review") === "Review");
    }
    this.dfComments = allComments;
    this.#commentManager.showSidebar(allComments);
  }
  addNewEditorFromKeyboard() {`,
  },

  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "if (this.#mode === mode && !editId) {\n      return;",
    note: "updateMode(): the stock early-return made 'Add Comment' a no-op when the annotation's tool was already active; only skip when there is no target editor",
    find: `  async updateMode(mode, editId = null, isFromUser = false, isFromKeyboard = false, mustEnterInEditMode = false, editComment = false) {
    if (this.#mode === mode) {
      return;
    }`,
    replace: `  async updateMode(mode, editId = null, isFromUser = false, isFromKeyboard = false, mustEnterInEditMode = false, editComment = false) {
    if (this.#mode === mode && !editId) {
      return;
    }`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "FREETEXT_FONT_FAMILY: 14",
    note: "free text: add the FREETEXT_FONT_FAMILY param type",
    find: `  FREETEXT_SIZE: 11,
  FREETEXT_COLOR: 12,
  FREETEXT_OPACITY: 13,`,
    replace: `  FREETEXT_SIZE: 11,
  FREETEXT_COLOR: 12,
  FREETEXT_OPACITY: 13,
  FREETEXT_FONT_FAMILY: 14,`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "dfFontName = null",
    note: "free text: font-family field on FreeTextEditor (Helv=Helvetica, Times-Roman, Courier)",
    find: `  static _defaultColor = null;
  static _defaultFontSize = 10;`,
    replace: `  static _defaultColor = null;
  static _defaultFontSize = 10;
  static _dfFontFamilyMap = {
    Helv: { css: "Helvetica, Arial, sans-serif", label: "Helvetica" },
    "Helvetica-Bold": { css: "Helvetica, Arial, sans-serif", style: "bold", label: "Helvetica Bold" },
    "Helvetica-Oblique": { css: "Helvetica, Arial, sans-serif", style: "italic", label: "Helvetica Oblique" },
    "Helvetica-BoldOblique": { css: "Helvetica, Arial, sans-serif", style: "bold italic", label: "Helvetica Bold Oblique" },
    "Times-Roman": { css: '"Times New Roman", Times, serif', label: "Times New Roman" },
    "Times-Bold": { css: '"Times New Roman", Times, serif', style: "bold", label: "Times New Roman Bold" },
    "Times-Italic": { css: '"Times New Roman", Times, serif', style: "italic", label: "Times New Roman Italic" },
    "Times-BoldItalic": { css: '"Times New Roman", Times, serif', style: "bold italic", label: "Times New Roman Bold Italic" },
    Courier: { css: '"Courier New", Courier, monospace', label: "Courier" },
    "Courier-Bold": { css: '"Courier New", Courier, monospace', style: "bold", label: "Courier Bold" },
    "Courier-Oblique": { css: '"Courier New", Courier, monospace', style: "italic", label: "Courier Oblique" },
    "Courier-BoldOblique": { css: '"Courier New", Courier, monospace', style: "bold italic", label: "Courier Bold Oblique" }
  };
  static _dfDefaultFontFamily = "Helv";
  dfFontName = null;`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "this.dfFontName = params.dfFontName || FreeTextEditor._dfDefaultFontFamily",
    note: "free text: read the font family in the constructor",
    find: `    this.color = params.color || FreeTextEditor._defaultColor || AnnotationEditor._defaultLineColor;
    this.#fontSize = params.fontSize || FreeTextEditor._defaultFontSize;`,
    replace: `    this.color = params.color || FreeTextEditor._defaultColor || AnnotationEditor._defaultLineColor;
    this.#fontSize = params.fontSize || FreeTextEditor._defaultFontSize;
    this.dfFontName = params.dfFontName || FreeTextEditor._dfDefaultFontFamily;`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "case AnnotationEditorParamsType.FREETEXT_FONT_FAMILY:\n        FreeTextEditor._dfDefaultFontFamily = value;",
    note: "free text: font-family defaults/current param plumbing",
    find: `      case AnnotationEditorParamsType.FREETEXT_COLOR:
        FreeTextEditor._defaultColor = value;
        break;
    }`,
    replace: `      case AnnotationEditorParamsType.FREETEXT_COLOR:
        FreeTextEditor._defaultColor = value;
        break;
      case AnnotationEditorParamsType.FREETEXT_FONT_FAMILY:
        FreeTextEditor._dfDefaultFontFamily = value;
        break;
    }`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "case AnnotationEditorParamsType.FREETEXT_FONT_FAMILY: {",
    note: "free text: apply the font family to a selected editor",
    find: `      case AnnotationEditorParamsType.FREETEXT_COLOR:
        this.#updateColor(value);
        break;
    }`,
    replace: `      case AnnotationEditorParamsType.FREETEXT_COLOR:
        this.#updateColor(value);
        break;
      case AnnotationEditorParamsType.FREETEXT_FONT_FAMILY: {
        const family = FreeTextEditor._dfFontFamilyMap[value];
        if (family && this.editorDiv) {
          this.editorDiv.style.fontFamily = family.css;
          this.editorDiv.style.fontStyle = family.style?.includes("italic") ? "italic" : "normal";
          this.editorDiv.style.fontWeight = family.style?.includes("bold") ? "bold" : "normal";
        }
        this.dfFontName = value;
        break;
      }
    }`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "[AnnotationEditorParamsType.FREETEXT_FONT_FAMILY, FreeTextEditor._dfDefaultFontFamily]]",
    note: "free text: expose the font family as a default param",
    find: `    return [[AnnotationEditorParamsType.FREETEXT_SIZE, FreeTextEditor._defaultFontSize], [AnnotationEditorParamsType.FREETEXT_COLOR, FreeTextEditor._defaultColor || AnnotationEditor._defaultLineColor]];`,
    replace: `    return [[AnnotationEditorParamsType.FREETEXT_SIZE, FreeTextEditor._defaultFontSize], [AnnotationEditorParamsType.FREETEXT_COLOR, FreeTextEditor._defaultColor || AnnotationEditor._defaultLineColor], [AnnotationEditorParamsType.FREETEXT_FONT_FAMILY, FreeTextEditor._dfDefaultFontFamily]];`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "[AnnotationEditorParamsType.FREETEXT_FONT_FAMILY, this.dfFontName || \"Helv\"]]",
    note: "free text: expose the font family of the selected editor",
    find: `    return [[AnnotationEditorParamsType.FREETEXT_SIZE, this.#fontSize], [AnnotationEditorParamsType.FREETEXT_COLOR, this.color]];`,
    replace: `    return [[AnnotationEditorParamsType.FREETEXT_SIZE, this.#fontSize], [AnnotationEditorParamsType.FREETEXT_COLOR, this.color], [AnnotationEditorParamsType.FREETEXT_FONT_FAMILY, this.dfFontName || "Helv"]];`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "const dfFamily = FreeTextEditor._dfFontFamilyMap[this.dfFontName] || FreeTextEditor._dfFontFamilyMap.Helv;",
    note: "free text: render the chosen font family in the editor (render + renderAnnotationElement)",
    find: `    const {
      style
    } = this.editorDiv;
    style.fontSize = \`calc(\${this.#fontSize}px * var(--total-scale-factor))\`;
    style.color = this.color;`,
    replace: `    const {
      style
    } = this.editorDiv;
    style.fontSize = \`calc(\${this.#fontSize}px * var(--total-scale-factor))\`;
    style.color = this.color;
    const dfFamily = FreeTextEditor._dfFontFamilyMap[this.dfFontName] || FreeTextEditor._dfFontFamilyMap.Helv;
    style.fontFamily = dfFamily.css;
    style.fontStyle = dfFamily.style?.includes("italic") ? "italic" : "normal";
    style.fontWeight = dfFamily.style?.includes("bold") ? "bold" : "normal";`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "style.fontFamily = dfFamily?.css || \"sans-serif\"",
    note: "free text: the annotation-layer view honors the font family too",
    find: `    style.fontSize = \`calc(\${this.#fontSize}px * var(--total-scale-factor))\`;
    style.color = this.color;
    content.replaceChildren();`,
    replace: `    style.fontSize = \`calc(\${this.#fontSize}px * var(--total-scale-factor))\`;
    style.color = this.color;
    const dfFamily = FreeTextEditor._dfFontFamilyMap[this.dfFontName];
    style.fontFamily = dfFamily?.css || "sans-serif";
    style.fontStyle = dfFamily?.style?.includes("italic") ? "italic" : "normal";
    style.fontWeight = dfFamily?.style?.includes("bold") ? "bold" : "normal";
    content.replaceChildren();`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "dfFontName: this.dfFontName || \"Helv\",\n      value: this.#serializeContent()",
    note: "free text: persist the font family in the serialized editor",
    find: `    const serialized = Object.assign(super.serialize(isForCopying), {
      color,
      fontSize: this.#fontSize,
      value: this.#serializeContent()
    });`,
    replace: `    const serialized = Object.assign(super.serialize(isForCopying), {
      color,
      fontSize: this.#fontSize,
      dfFontName: this.dfFontName || "Helv",
      value: this.#serializeContent()
    });`,
  },
  {
    file: "resources/pdf.js/build/pdf.mjs",
    marker: "editor.dfFontName = data.dfFontName ?? initialData?.dfFontName ?? \"Helv\"",
    note: "free text: restore the font family on deserialize (new and file-loaded editors)",
    find: `    const editor = await super.deserialize(data, parent, uiManager);
    editor.#fontSize = data.fontSize;
    editor.color = Util.makeHexColor(...data.color);
    editor.#content = FreeTextEditor.#deserializeContent(data.value);
    editor._initialData = initialData;`,
    replace: `    const editor = await super.deserialize(data, parent, uiManager);
    editor.#fontSize = data.fontSize;
    editor.color = Util.makeHexColor(...data.color);
    editor.dfFontName = data.dfFontName ?? initialData?.dfFontName ?? "Helv";
    editor.#content = FreeTextEditor.#deserializeContent(data.value);
    editor._initialData = initialData;`,
  },

  // --- web/viewer.mjs --------------------------------------------------------
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "editorFreeTextFontFamily",
    note: "free text toolbar: wire the font-family dropdown",
    find: `    editorFreeTextFontSize,
    editorFreeTextColor,`,
    replace: `    editorFreeTextFontSize,
    editorFreeTextColor,
    editorFreeTextFontFamily,`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "dispatchEvent(\"FREETEXT_FONT_FAMILY\", this.value)",
    note: "free text toolbar: dispatch font-family changes",
    find: `    editorFreeTextColor.addEventListener("input", function () {
      dispatchEvent("FREETEXT_COLOR", this.value);
    });`,
    replace: `    editorFreeTextColor.addEventListener("input", function () {
      dispatchEvent("FREETEXT_COLOR", this.value);
    });
    editorFreeTextFontFamily?.addEventListener("change", function () {
      dispatchEvent("FREETEXT_FONT_FAMILY", this.value);
    });`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "editorFreeTextFontFamily.value = value",
    note: "free text toolbar: keep the dropdown in sync with the selection",
    find: `          case AnnotationEditorParamsType.FREETEXT_COLOR:
            editorFreeTextColor.value = value;
            break;`,
    replace: `          case AnnotationEditorParamsType.FREETEXT_COLOR:
            editorFreeTextColor.value = value;
            break;
          case AnnotationEditorParamsType.FREETEXT_FONT_FAMILY:
            if (editorFreeTextFontFamily && [...editorFreeTextFontFamily.options].some(o => o.value === value)) {
              editorFreeTextFontFamily.value = value;
            }
            break;`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "editorFreeTextFontFamily: document.getElementById(\"editorFreeTextFontFamily\")",
    note: "free text toolbar: pass the dropdown to AnnotationEditorParams",
    find: `      editorFreeTextFontSize: document.getElementById("editorFreeTextFontSize"),
      editorFreeTextColor: document.getElementById("editorFreeTextColor"),`,
    replace: `      editorFreeTextFontSize: document.getElementById("editorFreeTextFontSize"),
      editorFreeTextColor: document.getElementById("editorFreeTextColor"),
      editorFreeTextFontFamily: document.getElementById("editorFreeTextFontFamily"),`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "dfCommentAuthor",
    note: "sidebar: show the author name and a Reply button on every comment",
    find: `    const commentItem = document.createElement("li");
    commentItem.role = "button";
    commentItem.className = "sidebarComment";
    commentItem.tabIndex = -1;
    commentItem.style.backgroundColor = color && CommentManager._makeCommentColor(color, opacity) || "";
    const dateDiv = document.createElement("time");
    this.#setDate(dateDiv, modificationDate || creationDate);
    const textDiv = document.createElement("div");
    textDiv.className = "sidebarCommentText";
    this.#setText(textDiv, richText, contentsObj);
    commentItem.append(dateDiv, textDiv);`,
    replace: `    const commentItem = document.createElement("li");
    commentItem.role = "button";
    commentItem.className = "sidebarComment";
    commentItem.tabIndex = -1;
    commentItem.style.backgroundColor = color && CommentManager._makeCommentColor(color, opacity) || "";
    const authorDiv = document.createElement("div");
    authorDiv.className = "dfCommentAuthor";
    authorDiv.textContent = annotation.user || "";
    authorDiv.hidden = !annotation.user;
    const dateDiv = document.createElement("time");
    dateDiv.classList.add("sidebarCommentDate");
    this.#setDate(dateDiv, creationDate || modificationDate);
    const textDiv = document.createElement("div");
    textDiv.className = "sidebarCommentText";
    this.#setText(textDiv, richText, contentsObj);
    commentItem.dataset.dfId = annotation.id || "";
    if (annotation.dfResolved) {
      commentItem.classList.add("dfResolved");
    }
    commentItem.append(authorDiv, dateDiv, textDiv);
    if (!annotation.inReplyTo && !annotation.dfParentId) {
      const replyButton = document.createElement("button");
      replyButton.type = "button";
      replyButton.className = "dfCommentReplyButton";
      replyButton.textContent = "Reply";
      replyButton.addEventListener("click", event => {
        event.stopPropagation();
        this.#eventBus.dispatch("dfcommentreply", {
          source: this,
          annotation
        });
      });
      commentItem.append(replyButton);
    }
    if (annotation.dfComment) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "dfCommentEditButton";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", event => {
        event.stopPropagation();
        this.#eventBus.dispatch("dfcommentedit", {
          source: this,
          annotation
        });
      });
      const resolveButton = document.createElement("button");
      resolveButton.type = "button";
      resolveButton.className = "dfCommentResolveButton";
      resolveButton.textContent = annotation.dfResolved ? "Unresolve" : "Resolve";
      resolveButton.addEventListener("click", event => {
        event.stopPropagation();
        this.#eventBus.dispatch("dfcommentresolve", {
          source: this,
          annotation
        });
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "dfCommentDeleteButton";
      deleteButton.textContent = "\\u00d7";
      deleteButton.setAttribute("aria-label", "Delete comment");
      deleteButton.addEventListener("click", event => {
        event.stopPropagation();
        this.#eventBus.dispatch("dfcommentdelete", {
          source: this,
          annotation
        });
      });
      commentItem.append(editButton, resolveButton, deleteButton);
    }`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "querySelector(\".sidebarCommentDate\")",
    note: "sidebar: updateComment must not assume date/text are first/last children anymore",
    find: `    this.#setDate(element.firstElementChild, modificationDate || creationDate);
    this.#setText(element.lastElementChild, richText, contentsObj);`,
    replace: `    this.#setDate(element.querySelector(".sidebarCommentDate"), creationDate || modificationDate);
    this.#setText(element.querySelector(".sidebarCommentText"), richText, contentsObj);`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "dfCommentReplies",
    note: "sidebar: thread replies (/IRT) underneath their parent comment",
    find: `    this.#annotations = annotations;
    annotations.sort(this.#sortComments.bind(this));
    if (annotations.length !== 0) {
      const fragment = document.createDocumentFragment();
      for (const annotation of annotations) {
        fragment.append(this.#createCommentElement(annotation));
      }
      this.#setCommentsCount(fragment);
      this.#commentsList.append(fragment);
    } else {
      this.#setCommentsCount();
    }
    this._sidebar.hidden = false;`,
    replace: `    this.#commentsList.replaceChildren();
    const parents = annotations.filter(a => !a.inReplyTo && !a.dfParentId);
    const replies = annotations.filter(a => a.inReplyTo || a.dfParentId);
    this.#annotations = parents;
    parents.sort(this.#sortComments.bind(this));
    if (parents.length !== 0) {
      const fragment = document.createDocumentFragment();
      for (const annotation of parents) {
        fragment.append(this.#createCommentElement(annotation));
      }
      this.#commentsList.append(fragment);
    }
    for (const reply of replies) {
      const parentItem = this.#idsToElements.get(reply.inReplyTo || reply.dfParentId);
      if (!parentItem) {
        this.#commentsList.append(this.#createCommentElement(reply));
        continue;
      }
      let list = parentItem.querySelector(":scope > .dfCommentReplies");
      if (!list) {
        list = document.createElement("div");
        list.className = "dfCommentReplies";
        parentItem.append(list);
      }
      list.append(this.#createCommentElement(reply));
    }
    this.#setCommentsCount();
    this._sidebar.hidden = false;`,
  },
  {
    file: "resources/pdf.js/web/viewer.mjs",
    marker: "contains(\"dfCommentReplies\")) {",
    note: "sidebar: removing a threaded reply must clean up its reply container",
    find: `  #removeComment(id) {
    const element = this.#idsToElements?.get(id);
    if (!element) {
      return;
    }`,
    replace: `  #removeComment(id) {
    const element = this.#idsToElements?.get(id);
    if (!element) {
      return;
    }
    if (element.parentElement?.classList.contains("dfCommentReplies")) {
      const list = element.parentElement;
      element.remove();
      if (!list.children.length) {
        list.remove();
      }
      this.#idsToElements.delete(id);
      this.#setCommentsCount();
      return;
    }`,
  },

  // --- web/viewer.html --------------------------------------------------------
  {
    file: "resources/pdf.js/web/viewer.html",
    marker: "editorFreeTextFontFamily",
    note: "free text toolbar: add a font-family dropdown (Helvetica/Times/Courier)",
    find: `                      <div class="editorParamsToolbarContainer">
                        <div class="editorParamsSetter">
                          <label for="editorFreeTextColor" class="editorParamsLabel" data-l10n-id="pdfjs-editor-free-text-color-input"></label>
                          <input type="color" id="editorFreeTextColor" class="editorParamsColor" tabindex="0" />
                        </div>`,
    replace: `                      <div class="editorParamsToolbarContainer">
                        <div class="editorParamsSetter">
                          <label for="editorFreeTextFontFamily" class="editorParamsLabel">Font</label>
                          <select id="editorFreeTextFontFamily" class="editorParamsDropdown" tabindex="0">
                            <option value="Helv" selected="selected">Helvetica</option>
                            <option value="Helvetica-Bold">Helvetica Bold</option>
                            <option value="Helvetica-Oblique">Helvetica Oblique</option>
                            <option value="Helvetica-BoldOblique">Helvetica Bold Oblique</option>
                            <option value="Times-Roman">Times New Roman</option>
                            <option value="Times-Bold">Times New Roman Bold</option>
                            <option value="Times-Italic">Times New Roman Italic</option>
                            <option value="Times-BoldItalic">Times New Roman Bold Italic</option>
                            <option value="Courier">Courier</option>
                            <option value="Courier-Bold">Courier Bold</option>
                            <option value="Courier-Oblique">Courier Oblique</option>
                            <option value="Courier-BoldOblique">Courier Bold Oblique</option>
                          </select>
                        </div>
                        <div class="editorParamsSetter">
                          <label for="editorFreeTextColor" class="editorParamsLabel" data-l10n-id="pdfjs-editor-free-text-color-input"></label>
                          <input type="color" id="editorFreeTextColor" class="editorParamsColor" tabindex="0" />
                        </div>`,
  },

  // --- build/pdf.worker.mjs ---------------------------------------------------
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "static _dfIsBase14(name) {",
    note: "worker: whitelist of PDF base-14 font names for free text (embed-free, readable everywhere)",
    find: `class Annotation {
  appearance = null;`,
    replace: `class Annotation {
  static _dfIsBase14(name) {
    return (
      name === "Helv" ||
      name === "Helvetica" || name === "Helvetica-Bold" ||
      name === "Helvetica-Oblique" || name === "Helvetica-BoldOblique" ||
      name === "Times-Roman" || name === "Times-Bold" ||
      name === "Times-Italic" || name === "Times-BoldItalic" ||
      name === "Courier" || name === "Courier-Bold" ||
      name === "Courier-Oblique" || name === "Courier-BoldOblique"
    ) ? name : "Helv";
  }
  appearance = null;`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "dfFontName",
    note: "worker: FreeText createNewDict — write the chosen base font into /DA",
    find: `    freetext.setIfArray("Rect", rect);
    const da = \`/Helv \${fontSize} Tf \${getPdfColor(color, true)}\`;
    freetext.set("DA", da);`,
    replace: `    freetext.setIfArray("Rect", rect);
    const dfBaseFont = Annotation._dfIsBase14(annotation.dfFontName);
    const da = \`/\${dfBaseFont} \${fontSize} Tf \${getPdfColor(color, true)}\`;
    freetext.set("DA", da);`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "const dfFontKey = Annotation._dfIsBase14(annotation.dfFontName);",
    note: "worker: FreeText appearance stream — render AP with the chosen base font",
    find: `    const resources = new Dict(xref);
    const font = new Dict(xref);
    if (baseFontRef) {
      font.set("Helv", baseFontRef);
    } else {
      const baseFont = new Dict(xref);
      baseFont.setIfName("BaseFont", "Helvetica");
      baseFont.setIfName("Type", "Font");
      baseFont.setIfName("Subtype", "Type1");
      baseFont.setIfName("Encoding", "WinAnsiEncoding");
      font.set("Helv", baseFont);
    }
    resources.set("Font", font);
    const helv = await WidgetAnnotation._getFontData(evaluator, task, {
      fontName: "Helv",
      fontSize
    }, resources);`,
    replace: `    const resources = new Dict(xref);
    const font = new Dict(xref);
    const dfFontKey = Annotation._dfIsBase14(annotation.dfFontName);
    const dfBaseFontName = dfFontKey === "Helv" ? "Helvetica" : dfFontKey;
    if (baseFontRef && dfFontKey === "Helv") {
      font.set("Helv", baseFontRef);
    } else {
      const baseFont = new Dict(xref);
      baseFont.setIfName("BaseFont", dfBaseFontName);
      baseFont.setIfName("Type", "Font");
      baseFont.setIfName("Subtype", "Type1");
      baseFont.setIfName("Encoding", "WinAnsiEncoding");
      font.set(dfFontKey, baseFont);
    }
    resources.set("Font", font);
    const helv = await WidgetAnnotation._getFontData(evaluator, task, {
      fontName: dfFontKey,
      fontSize
    }, resources);`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "0 Tc /\${dfFontKey} \${numberToString(newFontSize)} Tf",
    note: "worker: FreeText AP content stream uses the selected font key",
    find: `    const buffer = ["q", \`\${matrix.join(" ")} 0 0 cm\`, \`\${clipBox.join(" ")} re W n\`, \`BT\`, \`\${getPdfColor(color, true)}\`, \`0 Tc /Helv \${numberToString(newFontSize)} Tf\`];`,
    replace: `    const buffer = ["q", \`\${matrix.join(" ")} 0 0 cm\`, \`\${clipBox.join(" ")} re W n\`, \`BT\`, \`\${getPdfColor(color, true)}\`, \`0 Tc /\${dfFontKey} \${numberToString(newFontSize)} Tf\`];`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "Sticky notes render with the viewer's standard icon",
    note: "worker: TextAnnotation.createNewDict — create sticky notes with /T author and /IRT replies",
    find: `    } else {
      this.data.state = null;
      this.data.stateModel = null;
    }
  }
}
class LinkAnnotation extends Annotation {`,
    replace: `    } else {
      this.data.state = null;
      this.data.stateModel = null;
    }
  }
  static async createNewAppearanceStream() {
    // Sticky notes render with the viewer's standard icon; no AP stream needed.
    return null;
  }
  static createNewDict(annotation, xref, params) {
    const {
      date,
      oldAnnotation,
      rect,
      user
    } = annotation;
    const note = oldAnnotation || new Dict(xref);
    note.setIfNotExists("Type", Name.get("Annot"));
    note.setIfNotExists("Subtype", Name.get("Text"));
    note.setIfNotExists("Name", Name.get("Note"));
    if (!oldAnnotation) {
      note.set("CreationDate", \`D:\${getModificationDate(date)}\`);
    }
    note.set("M", \`D:\${getModificationDate(date)}\`);
    note.setIfArray("Rect", rect);
    note.setIfDefined("Contents", stringToAsciiOrUTF16BE(annotation.contents ?? annotation.popup?.contents));
    note.setIfDefined("T", stringToAsciiOrUTF16BE(user));
    const parentRef = annotation.dfParentRef || null;
    if (parentRef) {
      note.set("IRT", parentRef);
      note.setIfName("RT", "R");
    }
    if (annotation.dfParentId) {
      // Threaded in the sidebar; keep replies off the page canvas (HIDDEN|NOVIEW).
      note.set("F", 34);
    } else {
      note.setIfNotExists("F", 4);
    }
    if (annotation.resolved) {
      // Acrobat-style resolved thread (ISO 32000 Reviewers state model).
      note.set("State", Name.get("Closed"));
      note.set("StateModel", Name.get("Review"));
    } else if (oldAnnotation) {
      oldAnnotation.delete("State");
      oldAnnotation.delete("StateModel");
    }
    if (!annotation.popup) {
      // Stale pop-ups from a previous save would show outdated text.
      note.delete("Popup");
    }
    if (params.apRef || params.ap) {
      const n = new Dict(xref);
      note.set("AP", n);
      n.set("N", params.apRef || params.ap);
    }
    return note;
  }
}
class LinkAnnotation extends Annotation {`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "case 1001:\n          promises.push(TextAnnotation.createNewAnnotation",
    note: "worker: save df pseudo-editors (type 1001: sticky notes and replies)",
    find: `  static async saveNewAnnotations(evaluator, xref, task, annotations, imagePromises, changes) {
    let baseFontRef;
    const promises = [];`,
    replace: `  static async saveNewAnnotations(evaluator, xref, task, annotations, imagePromises, changes) {
    let baseFontRef;
    const promises = [];
    const dfRefs = new Map();
    for (const annotation of annotations) {
      if (annotation.deleted) {
        continue;
      }
      const isDf = annotation.annotationType === 1001 || annotation.dfId;
      if (!isDf) {
        continue;
      }
      if (!annotation.ref && !annotation.isCopy && !annotation.isClone) {
        annotation.ref = xref.getNewTemporaryRef();
      }
      if (!annotation.isCopy && !annotation.isClone) {
        dfRefs.set(annotation.dfId, annotation.ref || null);
      }
    }
    for (const annotation of annotations) {
      if (!annotation.deleted && annotation.dfParentId) {
        annotation.dfParentRef = dfRefs.get(annotation.dfParentId) ?? Ref.fromString(annotation.dfParentId) ?? null;
      }
      if (!annotation.deleted && annotation.popup && !annotation.popup.ref) {
        // Reuse the note's existing popup object so editing/moving never orphans it.
        annotation.popup.ref = annotation.oldAnnotation?.getRaw?.("Popup") || null;
      }
    }`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "case 1001:\n          promises.push(TextAnnotation.createNewAnnotation(xref, annotation, changes, {\n            dfRefs",
    note: "worker: dispatch case for df sticky notes/replies",
    find: `        case AnnotationEditorType.SIGNATURE:
          promises.push(StampAnnotation.createNewAnnotation(xref, annotation, changes, {}));
          break;
      }`,
    replace: `        case AnnotationEditorType.SIGNATURE:
          promises.push(StampAnnotation.createNewAnnotation(xref, annotation, changes, {}));
          break;
        case 1001:
          promises.push(TextAnnotation.createNewAnnotation(xref, annotation, changes, {
            dfRefs
          }));
          break;
      }`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "case 1001:\n          promises.push(TextAnnotation.createNewPrintAnnotation",
    note: "worker: print path for df sticky notes/replies",
    find: `        case AnnotationEditorType.SIGNATURE:
          promises.push(StampAnnotation.createNewPrintAnnotation(annotationGlobals, xref, annotation, {
            evaluatorOptions: options
          }));
          break;
      }`,
    replace: `        case AnnotationEditorType.SIGNATURE:
          promises.push(StampAnnotation.createNewPrintAnnotation(annotationGlobals, xref, annotation, {
            evaluatorOptions: options
          }));
          break;
        case 1001:
          promises.push(TextAnnotation.createNewPrintAnnotation(annotationGlobals, xref, annotation, {
            evaluatorOptions: options
          }));
          break;
      }`,
  },
  {
    file: "resources/pdf.js/build/pdf.worker.mjs",
    marker: "annotation.dfComment && !annotation.deleted && !Ref.fromString",
    note: "worker: df entries carry synthetic ids; skip ref-replacement for new pseudo-entries",
    find: `    for (const annotation of annotations) {
      if (annotation.id) {
        const ref = Ref.fromString(annotation.id);`,
    replace: `    for (const annotation of annotations) {
      if (annotation.dfComment && !annotation.deleted && !Ref.fromString(annotation.id)) {
        continue;
      }
      if (annotation.id) {
        const ref = Ref.fromString(annotation.id);`,
  },
];

let changed = 0;
const problems = [];
const sources = new Map();
const read = (path) => {
  if (!sources.has(path)) {
    sources.set(path, readFileSync(path, "utf8"));
  }
  return sources.get(path);
};
for (const patch of PATCHES) {
  const path = join(root, patch.file);
  const source = read(path);
  if (source.includes(patch.marker)) {
    continue; // already patched
  }
  if (!source.includes(patch.find)) {
    problems.push(`${patch.file}: anchor not found (${patch.note}).`);
    continue;
  }
  changed += 1;
  sources.set(path, source.replace(patch.find, patch.replace));
  console.log(`${checkOnly ? "would patch" : "patched"}: ${patch.file} — ${patch.note}`);
}
if (!checkOnly) {
  for (const [path, source] of sources) {
    if (source !== readFileSync(path, "utf8")) {
      writeFileSync(path, source);
    }
  }
}

if (problems.length > 0) {
  console.error("pdf.js patching failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
if (checkOnly && changed > 0) {
  console.error(`${changed} patch(es) missing; run 'node scripts/patch-pdfjs.mjs'.`);
  process.exit(1);
}
