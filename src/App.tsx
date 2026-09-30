import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { RequireUser } from './app/RequireUser'
import { RouteError } from './app/RouteError'
import { Shell } from './app/Shell'
import DeviceDetail from './pages/DeviceDetail'
import Devices from './pages/Devices'
import Events from './pages/Events'
import GroupEditor from './pages/GroupEditor'
import Groups from './pages/Groups'
import Login from './pages/Login'
import Matrix from './pages/Matrix'
import Nodes from './pages/Nodes'
import NotFound from './pages/NotFound'
import Overview from './pages/Overview'
import Targets from './pages/Targets'

const router = createBrowserRouter([
  {
    // 登录页不带外壳：侧栏上的导航在没登录时点了也没用
    path: 'login',
    element: <Login />,
    errorElement: <RouteError standalone />,
  },
  {
    element: (
      <RequireUser>
        <Shell />
      </RequireUser>
    ),
    errorElement: <RouteError standalone />,
    children: [
      {
        // 单个页面出错时只替换主内容区，侧栏导航还能用
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Overview /> },
          { path: 'devices', element: <Devices /> },
          { path: 'devices/:id', element: <DeviceDetail /> },
          { path: 'matrix', element: <Matrix /> },
          { path: 'events', element: <Events /> },
          { path: 'groups', element: <Groups /> },
          { path: 'groups/new', element: <GroupEditor /> },
          { path: 'groups/:id', element: <GroupEditor /> },
          { path: 'targets', element: <Targets /> },
          { path: 'nodes', element: <Nodes /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
])

export function App() {
  return <RouterProvider router={router} />
}
