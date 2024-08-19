import { AutomergeUrl } from "@automerge/automerge-repo"
import { useDocument, useRepo } from "@automerge/automerge-repo-react-hooks"
import { useCollection } from "@automerge/automerge-repo-react-hooks"
import { useState } from "react"
import { Menu } from "lucide-react"
import { Sidebar } from "./Sidebar"
import { FolderDoc, DatatypeId, DocLink, isFolderDoc } from "./types"
import { Button } from "./Button"
import { collectionToFolders } from "./collection"
import { next as A } from "@automerge/automerge"

function AppContent({ docUrl }: { docUrl: AutomergeUrl }) {
  const repo = useRepo()
  const collectionProgress = useCollection(docUrl)
  const [showSidebar, setShowSidebar] = useState(true)
  const [selectedDocUrl, selectDocUrl] = useState<AutomergeUrl | null>(null)
  const [allDocsLoaded, setAllDocsLoaded] = useState(false)

  if (collectionProgress.type === "synchronizing_index" || collectionProgress.type === "beginning") {
    return <div>synchronizing index</div>
  } else if (collectionProgress.type === "synchronizing_docs") {
    return <div>synchronizing docs ({collectionProgress.progress}/{collectionProgress.total}) </div>
  }

  const maybeCollection = collectionProgress.value
  if (maybeCollection == null) {
    return <div>collection not found</div>
  }
  console.log(`collection: ${JSON.stringify(maybeCollection, null, 2)}`)
  const {index: collection, addDoc} = maybeCollection

  const allDocs = Object.fromEntries(collection.entries.map((url) => [url, repo.find(url)]))
  if (!allDocsLoaded) {
    const allLoaded = Promise.all(Object.values(allDocs).map(d => d.doc()))
    allLoaded.then(() => {
      setAllDocsLoaded(true)
    })
  }

  console.log("all docs loaded")

  if (!allDocsLoaded) {
    return <div>Loading...</div>
  }

  allDocs[collection.rootUrl] = repo.find(collection.rootUrl)
  const { root: rootFolder, invertedIndex } = collectionToFolders(allDocs, docUrl)

  const addNewDocument = ({ type }: { type: DatatypeId }) => {
    if (type === "unknown") {
      throw new Error(`Unsupported document type: ${type}`);
    }

    let parentFolderUrl = collection.rootUrl
    if (selectedDocUrl != null) {
      const selectedDoc = repo.find(selectedDocUrl).docSync() 
      if (isFolderDoc(selectedDoc)) {
        parentFolderUrl = selectedDocUrl
      } else {
        const nearestFolder = invertedIndex.childrenToParents[selectedDocUrl]
        if (nearestFolder != null) {
          parentFolderUrl = nearestFolder
        }
      }
    }

    let newDocHandle
    let name
    if (type === "folder") {
      name = "Untitled Folder"
      newDocHandle = repo.create({ title: "Untitled Folder", docs: [] })
    } else {
      name = "Untitled Essay"
      newDocHandle = repo.create({ contents: "Untitled Essay" })
    }
    let newDocLink = {
      type,
      url: newDocHandle.url.toString() as AutomergeUrl,
      name
    }
    addDoc(newDocHandle.url)

    repo
      .find<FolderDoc>(parentFolderUrl)
      .change((doc) => doc.docs.unshift(newDocLink));

    selectDocUrl(newDocHandle.url)
  }


  let contents = <>no file selected</>
  if (selectedDocUrl != null) {
    contents = <Contents url={selectedDocUrl} />
  }

  return (
    <div className="flex flex-row w-screen h-screen overflow-hidden">
      <div
        className={`${showSidebar ? "w-64" : "w-0 translate-x-[-100%]"
          } flex-shrink-0 bg-gray-100 border-r border-gray-400 transition-all duration-100 overflow-hidden  `}
      >
        <Sidebar
          rootFolderDoc={rootFolder}
          selectedDocUrl={selectedDocUrl}
          selectDocUrl={selectDocUrl}
          hideSidebar={() => setShowSidebar(false)}
          addNewDocument={addNewDocument}
        />
      </div>
      <div
        className={`flex-grow relative h-screen overflow-hidden ${!selectedDocUrl ? "bg-gray-200" : ""
          }`}
      >
        <div className="flex flex-col h-screen">
          <TopBar
            showSidebar={showSidebar}
            setShowSidebar={setShowSidebar}
          />
          <div className="flex-grow overflow-hidden z-0">
            {!selectedDocUrl && (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div>
                  <p className="text-center cursor-default select-none mb-4">
                    No document selected
                  </p>
                  <Button
                    onClick={() => addNewDocument({ type: "essay" })} // Default type for new document
                    variant="outline"
                  >
                    Create new document
                    <span className="ml-2">(&#9166;)</span>
                  </Button>
                </div>
              </div>
            )}
            {selectedDocUrl && (
              <div className="h-full overflow-y-auto p-4">{contents}</div>)}

          </div>
        </div>
      </div>
    </div>
  )
}

function TopBar({ showSidebar, setShowSidebar }: { showSidebar: boolean, setShowSidebar: (showSidebar: boolean) => void }) {
  return <div className="h-10 bg-gray-100 flex items-center flex-shrink-0 border-b border-gray-300">
    {!showSidebar && (
      <div
        className="ml-1 p-1 text-gray-500 bg-gray-100 hover:bg-gray-300 hover:text-gray-500 cursor-pointer  transition-all rounded-sm"
        onClick={() => setShowSidebar(!showSidebar)}
      >
        <Menu size={18} />
      </div>
    )}
  </div>
}

function Contents({ url }: { url: AutomergeUrl }) {
  const [doc, changeDoc] = useDocument<{ contents: string } | { docs: DocLink[] }>(url)

  if (doc == null) {
    return <div>Loading...</div>
  }

  function onChangeContents(newContents: string) {
    changeDoc(d => {
      if ("contents" in d) {
        A.updateText(d, ["contents"], newContents)
      } else {
        // @ts-expect-error 
        d.contents = newContents
      }
    })
  }

  if ("contents" in doc) {
    return (
      <div>
        <textarea value={doc.contents} onChange={(e) => onChangeContents(e.target.value)} />
      </div>
    )
  } else {
    return (
      <div>
        <h2>Folder contents:</h2>
        <ul>
          {doc.docs.map((docLink) => <li key={docLink.url}>{docLink.name}</li>)}
        </ul>
      </div>
    )
  }
}

export default AppContent


