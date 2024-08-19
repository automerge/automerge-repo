import { AutomergeUrl, isValidAutomergeUrl } from "@automerge/automerge-repo";
import React, { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Folder as FolderIcon,
  Text as TextIcon,
} from "lucide-react";
import { Tree, NodeRendererProps, RenameHandler } from "react-arborist";
import { FillFlexParent } from "./FillFlexParent.jsx";

import {
  DatatypeId,
  DocLinkWithFolderPath,
  FolderDocWithChildren,
  FolderDocWithMetadata,
  isFolderDoc,
} from "./types";

import { Input } from "./Input";
import { uniqBy } from "lodash";
import { useRepo } from "@automerge/automerge-repo-react-hooks";

type TreeData = DocLinkWithFolderPath & {children: TreeData[] | undefined}

const Node = (props: NodeRendererProps<TreeData>) => {
  const { node, style, dragHandle } = props;
  let Icon;

  if (node.data.type === "folder") {
    if (node.isOpen) {
      Icon = ChevronDown;
    } else {
      Icon = ChevronRight;
    }
  } else {
    Icon = TextIcon
  }

  return (
    <div
      style={style}
      ref={dragHandle}
      className={`flex items-center cursor-pointer text-sm py-1 w-full truncate ${
        node.isSelected
          ? " bg-gray-300 hover:bg-gray-300 text-gray-900"
          : "text-gray-600 hover:bg-gray-200"
      }`}
      onDoubleClick={() => node.edit()}
    >
      <div
        className={`${node.isSelected ? "text-gray-800" : "text-gray-500"} ${
          node.data.type === "folder" && "hover:bg-gray-400 text-gray-800"
        } p-1 mr-0.5 rounded-sm transition-all`}
        onClick={() => { if (node.data.type === "folder") { node.toggle(); }
        }}
      >
        <Icon size={14} />
      </div>

      {!node.isEditing && (
        <>
          <div>
            {node.data.name}
          </div>
          {node.data.type === "folder" && (
            <div className="ml-2 text-gray-500 text-xs py-0.5 px-1.5 rounded-lg bg-gray-200">
              {node.children?.length || 0}
            </div>
          )}
        </>
      )}
      {node.isEditing && <Edit {...props} />}
    </div>
  );
};

const Edit = ({ node }: NodeRendererProps<TreeData>) => {
  const input = useRef<any>();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <input
      ref={input}
      defaultValue={node.data.name}
      onBlur={() => node.reset()}
      onKeyDown={(e) => {
        if (e.key === "Escape") node.reset();
        if (e.key === "Enter") node.submit(input.current?.value || "");
      }}
    ></input>
  );
};

type SidebarProps = {
  rootFolderDoc: FolderDocWithMetadata;
  selectedDocUrl: AutomergeUrl | null;
  selectDocUrl: (docUrl: AutomergeUrl | null) => void;
  hideSidebar: () => void;
  addNewDocument: (doc: { type: DatatypeId }) => void;
};

const prepareDataForTree = (
  folderDoc: FolderDocWithChildren,
  folderPath: AutomergeUrl[]
): TreeData[] => {
  if (!folderDoc) {
    return [];
  }
  return uniqBy(folderDoc.docs, "url").map((docLink) => ({
    ...docLink,
    folderPath,
    children:
      docLink.type === "folder" && docLink.folderContents
        ? prepareDataForTree(docLink.folderContents, [
            ...folderPath,
            docLink.url,
          ])
        : undefined,
  }));
};

const idAccessor = (item: DocLinkWithFolderPath) => {
  return JSON.stringify({
    url: item.url,
    folderPath: item.folderPath,
  });
};

export const Sidebar: React.FC<SidebarProps> = ({
  selectedDocUrl,
  selectDocUrl,
  hideSidebar,
  addNewDocument,
  rootFolderDoc,
}) => {
  const repo = useRepo();
  const {
    doc: rootFolderDocWithChildren,
    rootFolderUrl,
  } = rootFolderDoc;

  const [searchQuery, setSearchQuery] = useState("");

  const dataForTree = prepareDataForTree(rootFolderDocWithChildren, [
    rootFolderUrl,
  ]);

  const treeSelection = selectedDocUrl ?? null;

  const onRename: RenameHandler<TreeData> = async ({
    node,
    name,
  }) => {
    const handle = repo.find(node.data.url);
    const doc = handle.docSync();
    if (isFolderDoc(doc)) {
      handle.change((d) => {
        // @ts-expect-error -- we know this is a folder doc
        d.title = name;
      });
    }
  };


  return (
    <div className="flex flex-col h-screen">

      <div className="h-10 py-2 px-4 font-semibold text-gray-500 text-sm flex">
        <div className="mw-40 mt-[3px]">My Documents</div>
        <div className="ml-auto">
          <div
            className="text-gray-400 hover:bg-gray-300 hover:text-gray-500 cursor-pointer  transition-all p-1 m-[-4px] mr-[-8px] rounded-sm"
            onClick={hideSidebar}
          >
            <ChevronsLeft />
          </div>
        </div>
      </div>

      <div className="py-2  border-b border-gray-200">
        <div key="folder">
          {" "}
          <FolderIcon
            size={14}
            className="inline-block font-bold mr-2 align-top mt-[2px]"
          />
          <div
            className="py-1 px-2 text-sm text-gray-600 cursor-pointer hover:bg-gray-200 "
            onClick={() => addNewDocument({type: "folder"})}
          >
            New Folder
          </div>
        </div>
        <div key="essay">
          {" "}
          <TextIcon
            size={14}
            className="inline-block font-bold mr-2 align-top mt-[2px]"
          />
          <div
            className="py-1 px-2 text-sm text-gray-600 cursor-pointer hover:bg-gray-200 "
            onClick={() => addNewDocument({type: "essay"})}
          >
            New document
          </div>
        </div>
      </div>

      <div className="mx-2 my-2 flex gap-2 items-center">
        <Input
          placeholder="Search my docs..."
          className="h-6"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div
          className={`text-gray-400 text-xs cursor-pointer ${
            searchQuery.length > 0 ? "" : "invisible"
          }`}
          onClick={() => setSearchQuery("")}
        >
          Clear
        </div>
      </div>

      <div className="flex-grow overflow-auto">
        <FillFlexParent>
          {({ width, height }) => {
            return (
              <Tree
                data={dataForTree}
                width={width}
                height={height}
                openByDefault={false}
                searchTerm={searchQuery}
                rowHeight={28}
                selection={treeSelection || undefined}
                idAccessor={idAccessor}
                onRename={onRename}
                onSelect={(selections) => {
                  if (
                    !selections ||
                    selections.length === 0 ||
                    // ignore on select if the selection hasn't changed
                    // this can happens when the tree component is being initialized
                    selections[0].id === treeSelection
                  ) {
                    return false;
                  }
                  const newlySelectedDocLink = selections[0].data;
                  if (isValidAutomergeUrl(newlySelectedDocLink.url)) {
                    selectDocUrl(newlySelectedDocLink.url);
                  }
                }}
              >
                {Node}
              </Tree>
            );
          }}
        </FillFlexParent>
      </div>
    </div>
  );
};

