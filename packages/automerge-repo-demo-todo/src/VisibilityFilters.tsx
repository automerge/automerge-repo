import cn from "classnames"
import { VISIBILITY_FILTERS } from "./constants"

export const VisibilityFilters = () => {
  const activeFilter = VISIBILITY_FILTERS.INCOMPLETE //useSelector((state) => state.visibilityFilter)
  // const dispatch = useDispatch()

  return (
    <ul className="flex space-x-1 cursor-pointer">
      {Object.keys(VISIBILITY_FILTERS).map((filterKey) => {
        const currentFilter =
          VISIBILITY_FILTERS[filterKey as keyof typeof VISIBILITY_FILTERS]

        const selected = currentFilter === activeFilter

        const onClick = (e: any) => {
          e.preventDefault()
          // dispatch(setFilter(currentFilter))
        }

        return (
          <li className="leading-none" key={`filter-${currentFilter}`}>
            <button
              className={`${
                selected
                  ? "bg-gray-100 text-gray-700 px-3 py-2 font-medium text-sm rounded-md"
                  : "text-gray-500 hover:text-gray-700 px-3 py-2 font-medium text-sm rounded-md"
              }`}
              onClick={onClick}
            >
              {currentFilter}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
